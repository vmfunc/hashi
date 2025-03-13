#!/usr/bin/env bun
import { getConfig } from './config';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

console.log("hashi server");

const config = getConfig();
const { port } = config.server;

console.log(`Server Configuration:`);
console.log(`- Listening on port: ${port}`);

import('./server').catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
}); 