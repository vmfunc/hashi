#!/usr/bin/env bun
import { getConfig } from './config';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

console.log("hashi client");

const config = getConfig();
const { mainPcIp, mainPcPort } = config.client;

console.log(`Client Configuration:`);
console.log(`- Server IP: ${mainPcIp}`);
console.log(`- Server Port: ${mainPcPort}`);

if (mainPcIp === 'localhost' || mainPcIp === '127.0.0.1') {
  console.log("\nWARNING: mainPcIp is set to localhost in config.json.");
  console.log("This will not work for RDP forwarding as it needs to connect to your main PC.");
  console.log("Please update your config or use a proper IP address.");
}

import('./forwarder').catch(err => {
  console.error("Failed to start client:", err);
  process.exit(1);
}); 