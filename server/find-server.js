// Looks for Attic servers on the home network and prints what answers, the way a client's agent will.
// Run on any PC on the same Wi-Fi or network (Node only):  node server/find-server.js [--port 41980]
'use strict';
const { findServers, DEFAULT_PORT } = require('./discovery');

const i = process.argv.indexOf('--port');
const port = i > 0 ? Number(process.argv[i + 1]) : DEFAULT_PORT;

findServers({ port, timeoutMs: 2000 }).then(list => {
  if (!list.length) {
    console.log(`No Attic server answered on UDP ${port}.`);
    console.log('Check the server is running, both PCs are on the same network, and Windows Firewall on the');
    console.log(`server allows inbound UDP ${port} on the Private profile.`);
    process.exitCode = 1;
    return;
  }
  for (const s of list) console.log(`Found ${s.name}  →  http://${s.address}:${s.port}   (server id ${s.serverId})`);
}).catch(e => { console.error('Could not search: ' + e.message); process.exitCode = 1; });
