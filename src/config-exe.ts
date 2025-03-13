#!/usr/bin/env bun
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { defaultConfig, getConfig } from './config';
import type { AppConfig } from './config';
import path from 'path';
import fs from 'fs';
import readline from 'readline';

async function promptForInput(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {

  const args = process.argv.slice(2);
  const subcommand = args[0]?.toLowerCase();
  
  let configPath: string;
  try {
    if (process.argv[0].endsWith('.exe')) {
      configPath = path.join(dirname(process.argv[0]), 'config.json');
    } else {
      configPath = path.join(process.cwd(), 'config.json');
    }
  } catch (error) {
    configPath = path.join(process.cwd(), 'config.json');
  }

  if (subcommand === 'show') {
    try {
      const config = getConfig();
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error("Error loading config:", (error as Error).message);
      console.log("Using default configuration instead:");
      console.log(JSON.stringify(defaultConfig, null, 2));
    }
    process.exit(0);
  } else if (subcommand === 'set-client-ip') {
    const ip = args[1] || await promptForInput("Enter the IP address of the main PC: ");
    
    if (!ip) {
      console.error('Please provide an IP address');
      process.exit(1);
    }
    
    let config: Partial<AppConfig> = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      config = JSON.parse(JSON.stringify(defaultConfig));
    }
    
    if (!config.client) config.client = { ...defaultConfig.client };
    config.client.mainPcIp = ip;
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`Updated mainPcIp to ${ip} in ${configPath}`);
    process.exit(0);
  } else if (subcommand === 'set-port') {
    const portStr = args[1] || await promptForInput("Enter the port number: ");
    const port = parseInt(portStr, 10);
    
    if (isNaN(port)) {
      console.error('Please provide a valid port number');
      process.exit(1);
    }
    
    let config: Partial<AppConfig> = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } else {
      config = JSON.parse(JSON.stringify(defaultConfig));
    }
    
    if (!config.client) config.client = { ...defaultConfig.client };
    config.client.mainPcPort = port;
    
    if (!config.server) config.server = { ...defaultConfig.server };
    config.server.port = port;
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`Updated port to ${port} in ${configPath}`);
    process.exit(0);
  } else {
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
      console.log(`Created default config at ${configPath}`);
    }

    console.log("\nConfig Commands:");
    console.log("  show               - Show current configuration");
    console.log("  set-client-ip IP   - Set the IP address of the main PC");
    console.log("  set-port PORT      - Set the port for both client and server");
    console.log("\nExample:");
    console.log("  config.exe set-client-ip 192.168.1.100");
    process.exit(0);
  }
}

main().catch(error => {
  console.error("Error:", error);
  process.exit(1);
}); 