import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { getConfig } from './config';

const config = getConfig();
const { mainPcIp, mainPcPort, reconnectInterval } = config.client;

const CLIENT_HEARTBEAT_INTERVAL = 10000;
let clientHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastServerResponse = Date.now();
let connectionStartTime = 0;

const ipcServers: Map<number, net.Server> = new Map();
const clientConnections: Map<number, net.Socket[]> = new Map();
let ws: WebSocket | null = null;
let isReconnecting = false;

function getIPCPath(): string {
  const platform = process.platform;
  const tempPath = os.tmpdir();
  
  if (platform === 'win32') {
    return '\\\\?\\pipe\\discord-ipc-';
  } else if (platform === 'darwin') {
    return path.join(tempPath, 'discord-ipc-');
  } else if (platform === 'linux') {
    const runtimeDir = process.env.XDG_RUNTIME_DIR || tempPath;
    return path.join(runtimeDir, 'discord-ipc-');
  }
  
  throw new Error('Unsupported platform: ' + platform);
}

function createFakeDiscordIPC(index: number): void {
  const socketPath = getIPCPath() + index;
  
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      console.error(`Could not clean up socket at ${socketPath}: ${(err as Error).message}`);
      return;
    }
  }
  
  try {
    const server = net.createServer((socket) => {
      console.log(`App connected to IPC ${index}`);
      
      if (!clientConnections.has(index)) {
        clientConnections.set(index, []);
      }
      const connections = clientConnections.get(index)!;
      connections.push(socket);

      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'app_connected',
            channel: index,
            timestamp: Date.now()
          }));
        } catch (err) {
          console.error(`Error notifying server of app connection to IPC ${index}:`, err);
        }
      }

      socket.on('data', (data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'ipc_data',
            channel: index,
            data: data.toString('base64')
          }));
        }
      });

      socket.on('close', () => {
        console.log(`App disconnected from IPC ${index}`);
        const connIndex = connections.indexOf(socket);
        if (connIndex !== -1) {
          connections.splice(connIndex, 1);
        }
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            console.log(`Notifying server of app disconnection from IPC ${index}`);
            ws.send(JSON.stringify({
              type: 'app_disconnected',
              channel: index,
              timestamp: Date.now()
            }));
          } catch (err) {
            console.error(`Error notifying server of app disconnection from IPC ${index}:`, err);
          }
        }
      });

      socket.on('error', (err) => {
        console.error(`Error on client connection to fake IPC ${index}: ${err.message}`);
      });
    });

    server.listen(socketPath, () => {
      console.log(`IPC ${index} listening at ${socketPath}`);
    });

    server.on('error', (err) => {
      console.error(`Error on fake IPC ${index}: ${err.message}`);
      
      if (ipcServers.has(index)) {
        ipcServers.delete(index);
        setTimeout(() => {
          createFakeDiscordIPC(index);
        }, 5000);
      }
    });

    ipcServers.set(index, server);
  } catch (err) {
    console.error(`Failed to create fake IPC ${index}: ${(err as Error).message}`);
  }
}

function connectToMainPC(): void {
  if (isReconnecting) {
    console.log('Already attempting to reconnect, skipping duplicate attempt');
    return;
  }
  
  isReconnecting = true;
  console.log(`Connecting at ws://${mainPcIp}:${mainPcPort}`);
  
  if (clientHeartbeatTimer) {
    clearInterval(clientHeartbeatTimer);
    clientHeartbeatTimer = null;
  }
  
  if (ws) {
    try {
      ws.close();
    } catch (err) {
      console.error('Error closing existing WebSocket:', err);
    }
    ws = null;
  }
  
  try {
    connectionStartTime = Date.now();
    lastServerResponse = connectionStartTime;
    ws = new WebSocket(`ws://${mainPcIp}:${mainPcPort}`);
    
    const connectionTimeout = setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        const timeoutDuration = Math.floor((Date.now() - connectionStartTime)/1000);
        console.error(`Connection timeout after ${timeoutDuration}s - server unreachable`);
        ws.terminate();
        ws = null;
        isReconnecting = false;
        setTimeout(connectToMainPC, reconnectInterval);
      }
    }, 15000);
  
    ws.on('open', () => {
      const connectionTime = Math.floor((Date.now() - connectionStartTime)/1000);
      console.log(`Successfully connected to server after ${connectionTime}s`);
      console.log('Ready to forward IPC data');
      clearTimeout(connectionTimeout);
      lastServerResponse = Date.now();
      isReconnecting = false;
      
      if (clientHeartbeatTimer) {
        clearInterval(clientHeartbeatTimer);
      }
      
      clientHeartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'ping',
              timestamp: Date.now()
            }));
          } catch (err) {
            console.error('Error sending heartbeat ping:', err);
          }
        } else {
          if (clientHeartbeatTimer) {
            clearInterval(clientHeartbeatTimer);
            clientHeartbeatTimer = null;
          }
        }
      }, CLIENT_HEARTBEAT_INTERVAL);
      
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'ping',
            timestamp: Date.now()
          }));
        } catch (err) {
          console.error('Error sending initial ping:', err);
        }
      }
    });
  
    ws.on('message', (message) => {
      lastServerResponse = Date.now();
      try {
        const payload = JSON.parse(message.toString());
        
        if (payload.type === 'ipc_response' && payload.channel !== undefined) {
          const channelId = payload.channel;
          const data = Buffer.from(payload.data, 'base64');
          
          if (clientConnections.has(channelId)) {
            const connections = clientConnections.get(channelId)!;
            for (const conn of connections) {
              if (!conn.destroyed) {
                conn.write(data);
              }
            }
          }
        } else if (payload.type === 'clear_presence_ack') {
          console.log('Server acknowledged presence clearing request');
        } else if (payload.type === 'ping') {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'pong',
              timestamp: Date.now(),
              echo: payload.timestamp
            }));
          }
        } else if (payload.type === 'pong') {
        } else if (payload.type === 'app_presence_cleared') {
          console.log(`Server cleared presence for app on channel ${payload.channel}`);
        } else {
          console.log(`Received message of type: ${payload.type}`);
        }
      } catch (err) {
        console.error('Error processing server message:', err);
      }
    });
  
    ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
      clearTimeout(connectionTimeout);
      
      if (clientHeartbeatTimer) {
        console.log('Clearing heartbeat timer due to websocket error');
        clearInterval(clientHeartbeatTimer);
        clientHeartbeatTimer = null;
      }
      
      if (ws) {
        try {
          ws.close();
        } catch (closeErr) {
          console.error('Error closing WebSocket after error:', closeErr);
        }
      }
      
      ws = null;
      isReconnecting = false;
      setTimeout(connectToMainPC, reconnectInterval);
    });
  
    ws.on('close', (code, reason) => {
      const connDuration = Math.floor((Date.now() - connectionStartTime)/1000);
      console.log(`Connection lost after ${connDuration}s. Code: ${code}, Reason: ${reason || 'None'}`);
      console.log('Attempting to reconnect...');
      
      clearTimeout(connectionTimeout);
      
      if (clientHeartbeatTimer) {
        console.log('Clearing heartbeat timer due to connection closure');
        clearInterval(clientHeartbeatTimer);
        clientHeartbeatTimer = null;
      }
      
      ws = null;
      isReconnecting = false;
      setTimeout(connectToMainPC, reconnectInterval);
    });
  } catch (err) {
    console.error('Error creating WebSocket connection:', err);
    isReconnecting = false;
    setTimeout(connectToMainPC, reconnectInterval);
  }
}

function initializeIPCServers(): void {
  for (let i = 0; i < 10; i++) {
    createFakeDiscordIPC(i);
  }
}

function cleanup(): void {
  console.log('Client shutting down...');
  
  if (clientHeartbeatTimer) {
    clearInterval(clientHeartbeatTimer);
    clientHeartbeatTimer = null;
  }
  
  let cleanupCompleted = false;
  const finalCleanup = () => {
    if (cleanupCompleted) return;
    cleanupCompleted = true;
    
    console.log('Starting resource cleanup');
    
    for (const [index, server] of ipcServers.entries()) {
      console.log(`Closing fake IPC ${index}`);
      server.close();
      
      if (process.platform !== 'win32') {
        const socketPath = getIPCPath() + index;
        if (fs.existsSync(socketPath)) {
          try {
            fs.unlinkSync(socketPath);
          } catch (err) {
            console.error(`Could not clean up socket at ${socketPath}: ${(err as Error).message}`);
          }
        }
      }
    }
    
    ipcServers.clear();
    
    for (const [index, connections] of clientConnections.entries()) {
      for (const connection of connections) {
        if (!connection.destroyed) {
          connection.destroy();
        }
      }
    }
    
    clientConnections.clear();
    console.log('Cleanup completed');
  };
  
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      console.log('Sending clear presence request to server');
      const clearMessage = JSON.stringify({
        type: 'clear_presence',
        timestamp: Date.now()
      });
      
      ws.send(clearMessage);
      
      const cleanupTimeout = setTimeout(() => {
        console.log('Cleanup timeout - proceeding with socket closure');
        if (ws) {
          try {
            ws.close();
          } catch (err) {
            console.error('Error closing WebSocket:', err);
          }
          ws = null;
        }
        finalCleanup();
      }, 500);
      
      const originalOnMessage = ws?.onmessage;
      if (ws) {
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data.toString());
            if (data.type === 'clear_presence_ack') {
              console.log('Received presence clear acknowledgment from server');
              clearTimeout(cleanupTimeout);
              
              setTimeout(() => {
                if (ws) {
                  try {
                    ws.close();
                  } catch (err) {
                    console.error('Error closing WebSocket after ack:', err);
                  }
                  ws = null;
                }
                finalCleanup();
              }, 100);
              
              if (ws) {
                ws.onmessage = originalOnMessage || null;
              }
              return;
            }
          } catch (err) {
            console.error('Error parsing message during cleanup:', err);
          }
          
          if (originalOnMessage && ws) {
            originalOnMessage.call(ws, event);
          }
        };
      }
    } catch (err) {
      console.error('Error sending clear presence message:', err);
      if (ws) {
        try {
          ws.close();
        } catch (closeErr) {
          console.error('Error closing WebSocket after error:', closeErr);
        }
        ws = null;
      }
      finalCleanup();
    }
  } else {
    if (ws) {
      try {
        ws.close();
      } catch (err) {
        console.error('Error closing non-open WebSocket:', err);
      }
      ws = null;
    }
    finalCleanup();
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  console.log('Received SIGINT, cleaning up...');
  cleanup();
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, cleaning up...');
  cleanup();
  setTimeout(() => {
    process.exit(0);
  }, 1000);
});

console.log('RPC Forwarder Client starting...');
console.log(`Target: ${mainPcIp}:${mainPcPort}`);

connectToMainPC();
initializeIPCServers(); 