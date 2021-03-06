exports.actors = {};
exports.status  = {};

var net         = require('net')
  , pcap        = require('pcap')
  , util        = require('util')
  , devices     = require('./device')
  , server      = require('./server')
  , utility     = require('./utility')
  , discovered1 = require('./../discovery/discovery-mac').arp
  , discovered2 = require('./../discovery/discovery-ssdp').arp
  , activities  = require('./../api/api-manage-activity')
  , events      = require('./../api/api-manage-event')
  , groups      = require('./../api/api-manage-group')
  , tasks       = require('./../api/api-manage-task')
  , broker      = utility.broker
  ;


var logger = exports.logger = utility.logger('steward');


exports.observed = function(eventID) {
  var event = events.id2event(eventID);

  if (!!event) {
    event.observeP = true;
    event.lastTime = new Date();
  }
};


exports.report = function(eventID, meta) {
  var event = events.id2event(eventID);

  if (!event) return;

  event.observeP = false;
  if (!!meta.error) {
    logger.warning('event/' + eventID, meta);
    event.watchP = false;
    return;
  }

  event.watchP = true;
};


exports.performed = function(taskID) {
  var task = tasks.id2task(taskID);

  if (!!task) task.lastTime = new Date();

  return true;
};


var scan = function() {
  var activity, device, event, i, now, parameter, performance, performances, task, uuid;

  now = new Date();
  for (uuid in events.events) {
    if (!events.events.hasOwnProperty(uuid)) continue;

    event = events.events[uuid];
    if (event.conditionP) check(event, now);
    else if (!event.watchP) broker.publish('actors', 'observe', event.eventID, event.actor, event.observe, event.parameter);
  }

  for (uuid in activities.activities) {
    if (!activities.activities.hasOwnProperty(uuid)) continue;

    activity = activities.activities[uuid];
    if (!activity.armed) continue;

    if (observedP(activity.event)) {
      activity.lastTime = now;
      prepare(activity.task);
    }
  }

  for (uuid in events.events) {
    if (!events.events.hasOwnProperty(uuid)) continue;

    event = events.events[uuid];
    if (!event.conditionP) event.observeP = false;
  }

  performances = [];
  for (uuid in tasks.tasks) {
    if (!tasks.tasks.hasOwnProperty(uuid)) continue;

    task = tasks.tasks[uuid];
    if (!task.performP) continue;

    task.performP = false;

    performances.push({ taskID:    task.taskID
                      , devices:   participants(task.actor)
                      , perform:   task.perform
                      , parameter: task.parameter });
  }

  for (i = 0; i < performances.length; i++) {
    performance = performances[i];
// .info
    logger.notice('perform',
                { taskID: performance.taskID, perform: performance.perform, parameter: performance.parameter });

    for (device in performance.devices) {
      if (!performance.devices.hasOwnProperty(device)) continue;

      parameter = devices.expand(performance.parameter);
      broker.publish('actors', 'perform', performance.taskID, device, performance.perform, parameter);
    }
  }
};


var check = function(event, now) {
  var actor, entity, info, params, proplist;

  actor = exports.actors[event.actorType];
  if (!actor) return;
  entity = actor.$lookup(event.actorID);
  if (!entity) return;
  proplist = entity.proplist();
  if ((!!event.watchP) && (!!proplist.updated) && (event.watchP === proplist.updated.getTime())) {
    event.observeP = false;
    return;
  }
  if (!!proplist.updated) event.watchP = proplist.updated.getTime();

  info = utility.clone(proplist.info);
  info.status = proplist.status;

  try { params = JSON.parse(event.parameter); } catch(ex) { params = null; }
  event.observeP = (!!params) && evaluate(params, entity, info);
  if ((!!event.lastTime) && (!!event.observeP)) {
    if (!!event.previous) event.observeP = false;
    event.previous = true;
  } else event.previous = event.observeP;
  if (event.observeP) event.lastTime = now;
};

var evaluate = function(params, entity, info) {
  var p, result;

  switch (params.operator) {
    case 'equals':
      if ((params.operand1) && (params.operand2))
        return (evaluate(params.operand1, entity, info) === evaluate(params.operand2, entity, info));
      break;

    case 'not-equals':
      if ((params.operand1) && (params.operand2))
        return (evaluate(params.operand1, entity, info) !== evaluate(params.operand2, entity, info));
      break;

    case 'less-than':
      if ((params.operand1) && (params.operand2))
        return (evaluate(params.operand1, entity, info) < evaluate(params.operand2, entity, info));
      break;

    case 'less-than-or-equals':
      if ((params.operand1) && (params.operand2))
        return (evaluate(params.operand1, entity, info) <= evaluate(params.operand2, entity, info));
      break;

    case 'greater-than':
      if ((params.operand1) && (params.operand2))
        return (evaluate(params.operand1, entity, info) > evaluate(params.operand2, entity, info));
      break;

    case 'greater-than-or-equals':
      if ((params.operand1) && (params.operand2))
        return (evaluate(params.operand1, entity, info) >= evaluate(params.operand2, entity, info));
      break;

    case 'any-of':
      if ((!params.operand1) || (!params.operand2)) break;
      result = evaluate(params.operand1, entity, info);
      if (!util.isArray(params.operand2)) return (result === evaluate(params.operand2, entity, info));
      for (p = 0; p < params.operand2.length; p++) if (result === evaluate(params.operand2[p], entity, info)) return true;
      break;

    case 'none-of':
      if ((!params.operand1) || (!params.operand2)) break;
      result = evaluate(params.operand1, entity, info);
      if (!util.isArray(params.operand2)) return (result !== evaluate(params.operand2, entity, info));
      for (p = 0; p < params.operand2.length; p++) if (result === evaluate(params.operand2[p], entity, info)) return false;
      return true;

    case 'present':
      if (params.operand1) return (!!evaluate(params.operand1, entity, info));
      break;

    case 'not':
      if (params.operand1) return (!evaluate(params.operand1, entity, info));
      break;

    case 'and':
      if (!params.operands) return true;
      if (!util.isArray(params.operands)) return evaluate(params.operands, entity, info);
      for (p = 0; p < params.operands.length; p++) if (!evaluate(params.operands[p], entity, info)) return false;
      return true;

    case 'or':
      if (!params.operands) return false;
      if (!util.isArray(params.operands)) return evaluate(params.operands, entity, info);
      for (p = 0; p < params.operands.length; p++) if (evaluate(params.operands[p], entity, info)) return true;
      return false;

    default:
      if (typeof params === 'number') return params;
      if (typeof params === 'string') return devices.expand(params, entity);
      break;
  }

  return false;
};

var observedP = function(whoami) {
  var event, group, i, parts, result;

  parts = whoami.split('/');
  switch (parts[0]) {
    case 'event':
      event = events.id2event(parts[1]);
      return ((!!event) ? event.observeP : false);

    case 'group':
      group = groups.id2group(parts[1]);
      if ((!group) || (group.members.length < 1)) return false;

      for (i = 0; i < group.members.length; i++) {
        result = observedP(group.members[i].actor);
        switch (group.groupOperator) {
          case groups.operators.and:
            if (!result) return false;
            break;

          case groups.operators.or:
            if (result) return true;
            break;

          case groups.operators.not:
            return (!result);

          default:
            return false;
        }
      }
      return (group.groupOperator == groups.operators.and);

    default:
      return false;
  }
};


var prepare = function(whoami) {
  var task, group, i, parts;

  parts = whoami.split('/');
  switch (parts[0]) {
    case 'task':
      task = tasks.id2task(parts[1]);
      if (!task) break;
      task.performP = (task.guardType === '') || (observedP(task.guardType));
      break;

// TBD: temporal ordering
    case 'group':
      group = groups.id2group(parts[1]);
      if (!!group) for (i = 0; i < group.members.length; i++) prepare(group.members[i].actor);
      break;

    default:
      break;
  }
};

// TBD: temporal ordering

var participants = function(whoami) {
  var device, group, i, parts, result, results, task;

  results = {};

  parts = whoami.split('/');
  switch (parts[0]) {
    case 'task':
      task = tasks.id2task(parts[1]);
      return ((!!task) ? participants(task.actor) : {});

    case 'group':
      group = groups.id2group(parts[1]);
      if (!group) break;

      for (i = 0; i < group.members.length; i++) {
        result = participants(group.members[i].actor);
        for (device in result) if (result.hasOwnProperty(device)) results[device] = true;
      }
      break;

    default:
      results[whoami] = true;
      break;
  }

  return results;
};


var report = function(module, entry, now) {
  var last;

  if (!!entry.busyP) return;
  last = entry.last || 0;
  if (last >= require('./device').lastupdated) return;

  entry.busyP = true;
  entry.reporter(logger, { send: function(data) {/* jshint unused: false */
    entry.busyP = false;
    entry.last = now;
  }});
};


var loadedP = false;
var ifaces = exports.ifaces = utility.clone(require('os').networkInterfaces());

var listen = function(ifname, ifaddr) {
  return function(raw) {
    var arp, packet;

    packet = pcap.decode.packet(raw);
    if ((!packet.link) || (!packet.link.arp)) return;
    arp = packet.link.arp;
    if ((!arp.sender_ha) || (!arp.sender_pa)) return;

    ifaces[ifname].arp[arp.sender_pa] = arp.sender_ha;
    if (arp.operation === 'request') {
      if (!exports.uuid) exports.uuid = '2f402f80-da50-11e1-9b23-' + arp.sender_ha.split(':').join('');
    } else if (arp.operation === 'reply') {
      if (!exports.uuid) exports.uuid = '2f402f80-da50-11e1-9b23-' + arp.target_ha.split(':').join('');
    }
    discovered1(ifname, ifaddr, arp);
    discovered2(ifname, ifaddr, arp);
  };
};

var prime = function(ifaddr) {
  var i, ipaddr, prefix;

  prefix = ifaddr.split('.').slice(0, 3).join('.');
  for (i = 0; i < 5; i++) {
    ipaddr = prefix + '.' + (Math.floor(Math.random() * 254) + 1);
    if (ipaddr !== ifaddr) pinger(ipaddr);
  }
};

var pinger = function(ipaddr) {
  var socket = new net.Socket({ type: 'tcp4' });

  socket.setTimeout(500);
  socket.on('connect', function() {
    socket.destroy();
  }).on('timeout', function() {
    socket.destroy();
  }).on('error', function(error) {/* jshint unused: false */
  }).on('close', function(errorP) {/* jshint unused: false */
  }).connect(8888, ipaddr);
};


exports.forEachAddress = function(callback) {
  var ifa, ifaddrs, ifname;

  for (ifname in ifaces) {
    if (!ifaces.hasOwnProperty(ifname)) continue;

    ifaddrs = ifaces[ifname].addresses;
    for (ifa = 0; ifa < ifaddrs.length; ifa++) {
      if ((!ifaddrs[ifa].internal) && (ifaddrs[ifa].family === 'IPv4')) callback(ifaddrs[ifa].address);
    }
  }
};

exports.clientInfo = function(connection, secureP) {
  var props;
/*
  var ifname;
 */

  props = { loopback      : false
          , subnet        : false
          , local         : false
          , remoteAddress : connection.remoteAddress
          , secure        : secureP };

// NB: note that https://127.0.0.1 is remote access
  if (connection.remoteAddress === '127.0.0.1') props.loopback = !secureP;
  else {
// TBD: in node 0.11, this should be reworked....
//      would prefer to distinguish between on the same subnet or not
    props.subnet = true;
/*
    for (ifname in ifaces) {
      if (!ifaces.hasOwnProperty(ifname)) continue;

      if (!!ifaces[ifname].arp[connection.remoteAddress]) {
        props.subnet = true;
        break;
      }
    }
 */
  }

  props.local = props.loopback || props.subnet;

  return props;
};

// NB: this is the access policy for read-only access
exports.readP = function(clientInfo) {
  return (clientInfo.loopback || (clientInfo.subnet && clientInfo.secure) || (!!clientInfo.userID));
};


exports.start = function() {
  var captureP, errorP, ifa, ifaddrs, ifname, noneP;

  if (utility.acquiring > 0) return setTimeout(exports.start, 10);

  if (exports.uuid) {
    logger.info('start', { uuid: exports.uuid });
    server.start();
    setInterval(scan, 10 * 1000);
    setInterval(function() {
      var module, now;

      now = new Date();
      for (module in exports.status) if (exports.status.hasOwnProperty(module)) report(module, exports.status[module], now);
    }, 15 * 1000);
    return;
  }

  if (loadedP) return setTimeout(exports.start, 10);
  loadedP = true;

  utility.acquire(logger, __dirname + '/../actors', /^actor-.*\.js$/, 6, -3, ' actor');

  errorP = false;
  noneP = true;
  for (ifname in ifaces) {
    if ((!ifaces.hasOwnProperty(ifname)) || (ifname.substr(0, 5) === 'vmnet') || (ifname.indexOf('tun') !== -1)) continue;

    ifaddrs = ifaces[ifname];
    if (ifaddrs.length === 0) continue;

    captureP = false;
    for (ifa = 0; ifa < ifaddrs.length; ifa++) {
      if ((ifaddrs[ifa].internal) || (ifaddrs[ifa].family !== 'IPv4')) continue;

      logger.info('scanning ' + ifname);
      ifaces[ifname] = { addresses: ifaddrs, arp: {} };
      try {
        pcap.createSession(ifname, 'arp').on('packet', listen(ifname, ifaddrs[ifa].address));
        captureP = true;
      } catch(ex) {
// NB: referencing ifname in this exception catch confuses jshint about whether ifname is var'd above...
        logger.error('unable to scan ' + ifname, { diagnostic: ex.message });
        errorP = true;
      }

      break;
    }
    if (!captureP) continue;
    noneP = false;

    for (ifa = 0; ifa < ifaddrs.length; ifa++) {
      if ((!ifaddrs[ifa].internal) && (ifaddrs[ifa].family === 'IPv4')) prime(ifaddrs[ifa].address);
    }
  }
  if (noneP) {
    logger.error('no network interfaces');
    if (errorP) {
      if ((!!process.getgid) && ((!process.getuid) || (process.getuid() !== 0))) {
        console.log('hint: $ sudo sh -c "chmod g+r /dev/bpf*; chgrp ' + process.getgid() + ' /dev/bpf*"');
      }
      process.exit(1);
    }
  }

  for (ifname in ifaces) if ((ifaces.hasOwnProperty(ifname)) && (util.isArray(ifaces[ifname]))) delete(ifaces[ifname]);

  exports.status.logs = { reporter: function(logger, ws) { ws.send(JSON.stringify(utility.signals)); } };

  setTimeout(exports.start, 10);
};
