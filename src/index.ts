import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { defaultConfig, getConfig } from './config';
import type { AppConfig } from './config';

const args = process.argv.slice(2);
const mode = args[0]?.toLowerCase();

const isBun = typeof Bun !== 'undefined';
if (!isBun) {
  console.error("This application is designed to run with Bun.");
  process.exit(1);
}

if (mode === 'config') {
  const subcommand = args[1]?.toLowerCase();
  const configPath = path.join(process.cwd(), 'config.json');
  
  if (subcommand === 'show') {
    const config = getConfig();
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  } else if (subcommand === 'set-client-ip') {

    const ip = args[2];
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

    const port = parseInt(args[2], 10);
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
    console.log("\nConfig Commands:");
    console.log("  config show               - Show current configuration");
    console.log("  config set-client-ip IP   - Set the IP address of the main PC");
    console.log("  config set-port PORT      - Set the port for both client and server");
    process.exit(0);
  }
}

if (!mode || (mode !== 'client' && mode !== 'server')) {
  console.log("\nUsage: bun run index.ts <mode> [options]");
  console.log("\nModes:");
  console.log("  client    - Run as RDP client (on the remote/RDP machine)");
  console.log("  server    - Run as main PC server (on your local/physical machine)");
  console.log("  config    - Configure the application");
  console.log("\nExamples:");
  console.log("  bun run index.ts client        - Run as client with config.json settings");
  console.log("  bun run index.ts server        - Run as server with config.json settings");
  console.log("  bun run index.ts config show   - Show current configuration");
  console.log("\nConfiguration:");
  console.log("  The application uses a config.json file for settings.");
  console.log("  You can modify this file directly or use the config commands.");
  console.log("  Environment variables will still override config file settings.");
  process.exit(0);
}

if (mode === 'client') {
  console.log("Starting in CLIENT mode (RDP machine)");
  
  const config = getConfig();
  if (config.client.mainPcIp === 'localhost' || config.client.mainPcIp === '127.0.0.1') {
    console.log("\nWARNING: mainPcIp is set to localhost in config.json.");
    console.log("This will not work for RDP forwarding as it needs to connect to your main PC.");
    console.log("Please update your config.json file or use:");
    console.log(`  bun run index.ts config set-client-ip YOUR_MAIN_PC_IP\n`);
  }
  
  import('./forwarder');
} else if (mode === 'server') {
  console.log("Starting in SERVER mode");
  
  import('./server');
}