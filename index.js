'use strict'
var pull = require('pull-stream')
var EBT = require('epidemic-broadcast-trees')
var path = require('path')
var toPull = require('push-stream-to-pull-stream')
var isFeed = require('ssb-ref').isFeed

var Store = require('lossy-store')
var toUrlFriendly = require('base64-url').escape

var ReplicationManager = require('ssb-replication-manager')

function hook (hookable, fn) {
  if (typeof hookable === 'function' && hookable.hook) { hookable.hook(fn) }
}

function isEmpty (o) {
  for (var k in o) return false
  return true
}
exports.name = 'ebt'

exports.version = '1.1.0'

exports.manifest = {
  replicate: 'duplex',
  // Todo: the documented api says request is exported but it's not.
  request: 'sync',
  peerStatus: 'sync'
}
exports.permissions = {
  anonymous: {allow: ['replicate']}
}

function checkClock (clock, message) {
  for (var k in clock) {
    if (!isFeed(k)) {
      console.error(message, k)
      delete clock[k]
    }
  }
}

exports.init = function (sbot, config) {
  config.replicate = config.replicate || {}
  config.replicate.fallback = true

  var dir = config.path ? path.join(config.path, 'ebt') : null
  var store = Store(dir, null, toUrlFriendly)

  var ebt = EBT({
    logging: config.ebt && config.ebt.logging,
    id: sbot.id,
    getClock: function (id, cb) {
      store.ensure(id, function () {
        var clock = store.get(id) || {}
        checkClock(clock, 'non-feed key when loading clock')
        cb(null, clock)
      })
    },
    setClock: function (id, clock) {
      checkClock(clock, 'non-feed key when saving clock')
      store.set(id, clock)
    },
    getAt: function (pair, cb) {
      sbot.getAtSequence([pair.id, pair.sequence], function (err, data) {
        cb(err, data ? data.value : null)
      })
    },
    append: function (msg, cb) {
      sbot.add(msg, function (err, msg) {
        cb(err && err.fatal ? err : null, msg)
      })
    },
    isFeed: isFeed
  })

  function getPeerAheadBy (feedId) {
    var status = peerStatus(feedId)
    var peers = status.peers
    var ourSeqForPeer = status.seq

    if (isEmpty(peers)) return 0

    var seqs = Object.keys(peers).map(function (peer) {
      return peers[peer].seq
    })

    // Find the largest value that the peer is ahead by.
    return seqs.reduce(function (acc, seq) {
      return Math.max(acc, seq - ourSeqForPeer)
    }, 0)
  }

  console.log('Init replication manager')

  setInterval(() => console.log('tick from ssb-ebt'), 5000)
  var replicationManager = ReplicationManager({
    request: ebt.request,
    getPeerAheadBy: getPeerAheadBy
  })

  sbot.getVectorClock(function (err, clock) {
    // TODO: is this the right thing to do here? I'm guessing we should do _something_ with the error.
    ebt.state.clock = clock || {}
    ebt.update()
  })

  sbot.post(function (msg) {
    ebt.onAppend(msg.value)
  })

  // HACK: patch calls to replicate.request into ebt, too.
  hook(sbot.replicate.request, function (fn, args) {
    if (!isFeed(args[0])) return
    replicationManager.request(args[0], args[1])
    return fn.apply(this, args)
  })

  //  hook(sbot.progress, function (fn) {
  //    var prog = fn()
  //    var p = ebt.progress()
  //    if (p.target) prog.ebt = p
  //    return prog
  //  })

  function onClose () {
    sbot.emit('replicate:finish', ebt.state.clock)
  }

  sbot.on('rpc:connect', function (rpc, isClient) {
    if (isClient) {
      var opts = {version: 3}
      var a = toPull.duplex(ebt.createStream(rpc.id, opts.version, true))
      var b = rpc.ebt.replicate(opts, function (err) {
        if (err) {
          rpc.removeListener('closed', onClose)
          rpc._emit('fallback:replicate', err)
        }
      })

      pull(a, b, a)
      rpc.on('closed', onClose)
    }
  })

  // wait till next tick, incase ssb-friends hasn't been installed yet.
  setImmediate(function () {
    if (sbot.friends) {
      function handleBlockUnlock (from, to, value) {
        if (value === false) { ebt.block(from, to, true) } else if (ebt.state.blocks[from] && ebt.state.blocks[from][to]) { ebt.block(from, to, false) }
      }

      pull(
        sbot.friends.stream({live: true}),
        pull.drain(function (contacts) {
          if (!contacts) return

          if (isFeed(contacts.from) && isFeed(contacts.to)) { // live data
            handleBlockUnlock(contacts.from, contacts.to, contacts.value)
          } else { // initial data
            for (var from in contacts) {
              var relations = contacts[from]
              for (var to in relations) { handleBlockUnlock(from, to, relations[to]) }
            }
          }
        })
      )
    }
  })
  function peerStatus (id) {
    id = id || sbot.id
    var data = {
      id: id,
      seq: ebt.state.clock[id],
      peers: {}
    }
    for (var k in ebt.state.peers) {
      var peer = ebt.state.peers[k]

      if (peer && peer.clock && peer.replicating && peer.clock[id] != null && peer.replicating[id] != null) {
      // if (peer.clock[id] != null || peer.replicating[id] != null) {
        var rep = peer.replicating[id]
        data.peers[k] = {
          seq: peer.clock[id],
          replicating: rep
        }
      }
    }
    return data
  }
  function request (feedId, isReplicationEnabled) {
    replicationManager.request(feedId, isReplicationEnabled)
  }
  return {
    replicate: function (opts) {
      if (opts.version !== 2 && opts.version !== 3) { throw new Error('expected ebt.replicate({version: 3 or 2})') }
      return toPull.duplex(ebt.createStream(this.id, opts.version))
    },
    // get replication status for feeds for this id.
    peerStatus: peerStatus,

    // TODO: request wasn't actually exported in ssb-ebt. Mistake or intentional?
    request: request
  }
}
