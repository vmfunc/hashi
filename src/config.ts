import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';

interface ClientConfig {
  mainPcIp: string;
  mainPcPort: number;
  reconnectInterval: number;
}

interface ServerConfig {
  port: number;
  maxClients: number;
}

export interface AppConfig {
  client: ClientConfig;
  server: ServerConfig;
}

const defaultConfig: AppConfig = {
  client: {
    mainPcIp: 'localhost',
    mainPcPort: 3838,
    reconnectInterval: 5000
  },
  server: {
    port: 3838,
    maxClients: 5
  }
};

function getConfigPath(): string {
  const cwdPath = join(process.cwd(), 'config.json');
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  
  try {
    const execPath = process.argv[0];
    if (execPath.endsWith('.exe')) {
      const execDir = dirname(execPath);
      const execConfigPath = join(execDir, 'config.json');
      if (existsSync(execConfigPath)) {
        return execConfigPath;
      }
    }
  } catch (error) {
  }
  
  try {
    const scriptPath = join(import.meta.dir, '..', 'config.json');
    if (existsSync(scriptPath)) {
      return scriptPath;
    }
  } catch (error) {
    // Ignore
  }
  
  console.log('No config.json found. Creating a default one in the current directory.');
  writeFileSync(cwdPath, JSON.stringify(defaultConfig, null, 2));
  console.log(`Default config file created at ${cwdPath}`);
  return cwdPath;
}

export function loadConfig(): AppConfig {
  try {
    const configPath = getConfigPath();
    console.log(`Loading config from ${configPath}`);
    const rawConfig = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(rawConfig) as AppConfig;
    
    return {
      client: {
        ...defaultConfig.client,
        ...config.client
      },
      server: {
        ...defaultConfig.server,
        ...config.server
      }
    };
  } catch (error) {
    console.error(`Error loading config: ${(error as Error).message}`);
    console.log('Using default configuration');
    return defaultConfig;
  }
}

export function applyEnvironmentOverrides(config: AppConfig): AppConfig {
  const updatedConfig = { ...config };
  
  if (process.env.MAIN_PC_IP) {
    updatedConfig.client.mainPcIp = process.env.MAIN_PC_IP;
  }
  
  if (process.env.MAIN_PC_PORT) {
    updatedConfig.client.mainPcPort = parseInt(process.env.MAIN_PC_PORT, 10);
  }
  
  if (process.env.PORT) {
    updatedConfig.server.port = parseInt(process.env.PORT, 10);
  }
  
  return updatedConfig;
}

export function getConfig(): AppConfig {
  const config = loadConfig();
  return applyEnvironmentOverrides(config);
}

export { defaultConfig }; 