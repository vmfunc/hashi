import WebSocket, { WebSocketServer } from 'ws';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getConfig } from './config';

const config = getConfig();
const { port, maxClients } = config.server;

const wss = new WebSocketServer({ port });
console.log(`Server started on port ${port}`);

let connectedClients = 0;

const discordConnections = new Map<number, net.Socket>();

const clientHeartbeats = new Map<WebSocket, { 
  lastPing: number, 
  timeout: ReturnType<typeof setTimeout>, 
  initialConnectionPhase: boolean,
  connectionId: string
}>();


const discordSocketLastUsed = new Map<number, number>();


const IPC_SOCKET_CLEANUP_INTERVAL = 120000; 
const IPC_SOCKET_INACTIVITY_THRESHOLD = 300000; 


const HEARTBEAT_INTERVAL = 15000;

const HEARTBEAT_TIMEOUT = 45000;

const INITIAL_CONNECTION_GRACE_PERIOD = 90000;


const heartbeatInterval = setInterval(() => {
  const now = Date.now();
  const clientCount = clientHeartbeats.size;
  
  
  for (const [client, heartbeat] of clientHeartbeats.entries()) {
    const clientId = heartbeat.connectionId;
    const lastPingAge = Math.floor((now - heartbeat.lastPing)/1000);
    
    
    if (heartbeat.initialConnectionPhase) {
      
      if (now - heartbeat.lastPing > INITIAL_CONNECTION_GRACE_PERIOD) {
        console.log(`Client ${clientId} initial connection grace period ended (${lastPingAge}s since last ping)`);
        heartbeat.initialConnectionPhase = false;
      }
      continue; 
    }
    
    if (now - heartbeat.lastPing > HEARTBEAT_TIMEOUT) {
      console.log(`Client ${clientId} heartbeat timeout - no response for ${lastPingAge}s - considering disconnected`);
      
      if (client.readyState === WebSocket.OPEN) {
        
        console.log(`Forcibly closing connection to client ${clientId} due to timeout`);
        client.close(1001, 'Connection timeout');
      }
    } else if (client.readyState === WebSocket.OPEN) {
      
      try {
        
        const pingData = JSON.stringify({ type: 'ping', timestamp: now });
        client.send(pingData);
      } catch (err) {
        console.error(`Error sending ping to client ${clientId}:`, err);
      }
    }
  }
}, HEARTBEAT_INTERVAL);


function cleanupInactiveIPCSockets() {
  const now = Date.now();
  let inactiveSockets = 0;
  const totalSockets = discordSocketLastUsed.size;
  
  
  for (const [id, lastUsed] of discordSocketLastUsed.entries()) {
    const inactiveTime = Math.floor((now - lastUsed)/1000);
    
    if (now - lastUsed > IPC_SOCKET_INACTIVITY_THRESHOLD) {
      console.log(`IPC socket ${id} inactive for ${inactiveTime}s (threshold: ${IPC_SOCKET_INACTIVITY_THRESHOLD/1000}s)`);
      
      if (discordConnections.has(id)) {
        const socket = discordConnections.get(id)!;
        if (!socket.destroyed) {
          console.log(`Closing inactive IPC socket ${id} (inactive for ${inactiveTime}s)`);
          
          try {
            
            try {
              console.log(`Sending clear presence to inactive IPC socket ${id}`);
              clearPresenceForChannel(id);
            } catch (err) {
              console.error(`Error trying to clear presence on inactive socket ${id}:`, err);
            }
            
            
            setTimeout(() => {
              if (!socket.destroyed) {
                console.log(`Destroying inactive IPC socket ${id} after clear presence attempt`);
                socket.destroy();
              }
              discordConnections.delete(id);
              discordSocketLastUsed.delete(id);
              console.log(`Inactive IPC socket ${id} has been removed from tracking`);
            }, 100);
            
            inactiveSockets++;
          } catch (err) {
            console.error(`Error closing inactive IPC socket ${id}:`, err);
            discordConnections.delete(id);
            discordSocketLastUsed.delete(id);
          }
        } else {
          
          discordConnections.delete(id);
          discordSocketLastUsed.delete(id);
        }
      } else {
        
        discordSocketLastUsed.delete(id);
      }
    }
  }
  
  if (inactiveSockets > 0) {
    console.log(`Cleaned up ${inactiveSockets}/${totalSockets} inactive IPC sockets`);
  }
}


const ipcSocketCleanupInterval = setInterval(cleanupInactiveIPCSockets, IPC_SOCKET_CLEANUP_INTERVAL);


process.on('exit', () => {
  clearInterval(heartbeatInterval);
  clearInterval(ipcSocketCleanupInterval);
});

function getLocalIPCPath(): string {
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

wss.on('connection', (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress;
  connectedClients++;
  
  if (connectedClients > maxClients) {
    console.log(`Too many clients (${connectedClients}/${maxClients})`);
    ws.close(1013, "Maximum number of connections reached");
    connectedClients--;
    return;
  }
  
  console.log(`Connected from ${clientIp} (${connectedClients}/${maxClients})`);
  
  
  const timeout = setTimeout(() => {
    
    if (ws.readyState === WebSocket.OPEN && clientHeartbeats.has(ws)) {
      const heartbeat = clientHeartbeats.get(ws)!;
      
      if (heartbeat.initialConnectionPhase) {
        console.log('Initial connection backup timeout triggered');
        ws.close(1001, 'Initial connection backup timeout');
      }
    }
  }, INITIAL_CONNECTION_GRACE_PERIOD * 1.5); 
  
  clientHeartbeats.set(ws, { 
    lastPing: Date.now(),
    timeout,
    initialConnectionPhase: true, 
    connectionId: clientIp || 'unknown-client'
  });
  
  ws.on('message', (message: WebSocket.RawData) => {
    try {
      const payload = JSON.parse(message.toString());
      
      
      if (clientHeartbeats.has(ws)) {
        const heartbeat = clientHeartbeats.get(ws)!;
        const clientId = heartbeat.connectionId;
        heartbeat.lastPing = Date.now();
        
        
        if (heartbeat.initialConnectionPhase) {
          console.log(`Client ${clientId} sent first message, exiting initial connection phase`);
          heartbeat.initialConnectionPhase = false;
        }
      }
      
      
      if (payload.type === 'pong') {
        
        return; 
      } else if (payload.type === 'ping') {
        
        if (ws.readyState === WebSocket.OPEN) {
          
          ws.send(JSON.stringify({ 
            type: 'pong', 
            timestamp: Date.now(),
            echo: payload.timestamp
          }));
        }
        return;
      }
      
      if (payload.type === 'ipc_data') {
        const channelId = payload.channel;
        const data = Buffer.from(payload.data, 'base64');
        
        
        discordSocketLastUsed.set(channelId, Date.now());
        
        if (!discordConnections.has(channelId)) {
          const localPath = getLocalIPCPath() + channelId;
          try {
            const localSocket = net.createConnection(localPath);
            
            localSocket.on('data', (responseData) => {
              
              discordSocketLastUsed.set(channelId, Date.now());
              
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'ipc_response',
                  channel: channelId,
                  data: responseData.toString('base64')
                }));
              }
            });
            
            localSocket.on('error', (err) => {
              console.error(`Error connecting to local IPC ${channelId}: ${err.message}`);
              discordConnections.delete(channelId);
            });
            
            localSocket.on('close', () => {
              console.log(`Local IPC ${channelId} closed`);
              discordConnections.delete(channelId);
            });
            
            discordConnections.set(channelId, localSocket);
            discordSocketLastUsed.set(channelId, Date.now());
            console.log(`Connected to local IPC ${channelId}`);
          } catch (err) {
            console.error(`Failed to connect to local IPC ${channelId}: ${(err as Error).message}`);
            return;
          }
        }
        
        const localSocket = discordConnections.get(channelId);
        if (localSocket && !localSocket.destroyed) {
          localSocket.write(data);
        }
      } else if (payload.type === 'app_connected') {
        
        console.log(`App connected to client IPC ${payload.channel}`);
        
      } else if (payload.type === 'app_disconnected') {
        
        const channelId = payload.channel;
        console.log(`App disconnected from client IPC ${channelId} - clearing presence`);
        
        
        const cleared = clearPresenceForChannel(channelId);
        
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'app_presence_cleared',
            channel: channelId,
            success: cleared,
            timestamp: Date.now()
          }));
        }
      } else if (payload.type === 'clear_presence') {
        console.log('Received clear presence request from client');
        clearAllRichPresence();
        
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'clear_presence_ack',
            timestamp: Date.now()
          }));
        }
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  ws.on('close', (code, reason) => {
    const clientId = clientHeartbeats.has(ws) ? clientHeartbeats.get(ws)!.connectionId : 'unknown';
    console.log(`Client ${clientId} disconnected (${--connectedClients}/${maxClients} active) - Code: ${code}, Reason: ${reason || 'None'}`);
    
    
    if (clientHeartbeats.has(ws)) {
      const heartbeat = clientHeartbeats.get(ws)!;
      clearTimeout(heartbeat.timeout);
      clientHeartbeats.delete(ws);
    }
    
    
    console.log(`Clearing rich presence for disconnected client ${clientId}`);
    clearAllRichPresence();
    
    console.log(`All Discord IPC connections cleared due to client ${clientId} disconnection`);
  });
  
  
  ws.on('error', (error) => {
    const clientId = clientHeartbeats.has(ws) ? clientHeartbeats.get(ws)!.connectionId : 'unknown';
    console.error(`WebSocket error for client ${clientId}:`, error);
    
  });
});

function logAvailableIPCChannels(): void {
  const basePath = getLocalIPCPath();
  console.log('Looking for IPC channels:');
  
  for (let i = 0; i < 10; i++) {
    const currentPath = basePath + i;
    
    if (process.platform === 'win32') {
      const testSocket = net.createConnection(currentPath);
      testSocket.on('connect', () => {
        console.log(`- IPC ${i} available at ${currentPath}`);
        testSocket.end();
      });
      testSocket.on('error', () => {
        testSocket.destroy();
      });
    } else if (fs.existsSync(currentPath)) {
      console.log(`- IPC ${i} available at ${currentPath}`);
    }
  }
}

console.log(`Server is running on port ${port}`);
console.log('Make sure Discord is running on this machine');
logAvailableIPCChannels();


process.on('SIGINT', () => {
  console.log('Server shutting down...');
  clearInterval(heartbeatInterval);
  clearInterval(ipcSocketCleanupInterval);
  clearAllRichPresence();
  
  
  setTimeout(() => {
    process.exit(0);
  }, 300);
});

process.on('SIGTERM', () => {
  console.log('Server terminating...');
  clearInterval(heartbeatInterval);
  clearInterval(ipcSocketCleanupInterval);
  clearAllRichPresence();
  
  
  setTimeout(() => {
    process.exit(0);
  }, 300);
});


function clearPresenceForChannel(channelId: number): boolean {
  console.log(`Clearing rich presence for channel ${channelId}`);
  
  if (!discordConnections.has(channelId)) {
    console.log(`No active Discord connection for channel ${channelId}`);
    return false;
  }
  
  const socket = discordConnections.get(channelId)!;
  
  if (socket.destroyed) {
    console.log(`Socket for IPC ${channelId} already destroyed, removing from tracking`);
    discordConnections.delete(channelId);
    return false;
  }
  
  try {
    
    const clearPresenceOp = 1; 
    const clearPresencePayload = JSON.stringify({
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: null
      },
      nonce: `clear-channel-${channelId}-${Date.now()}`
    });
    
    
    const payloadBuffer = Buffer.from(clearPresencePayload, 'utf8');
    const messageBuffer = Buffer.alloc(8 + payloadBuffer.length);
    messageBuffer.writeInt32LE(payloadBuffer.length, 0);
    messageBuffer.writeInt32LE(clearPresenceOp, 4);
    payloadBuffer.copy(messageBuffer, 8);
    
    
    const writeSuccess = socket.write(messageBuffer, (err) => {
      if (err) {
        console.error(`Error during write completion for IPC ${channelId}: ${err.message}`);
      } else {
        console.log(`Successfully sent clear presence to IPC ${channelId}`);
      }
      
      
      setTimeout(() => {
        try {
          if (!socket.destroyed) {
            socket.destroy();
          }
        } catch (destroyErr) {
          console.error(`Error destroying socket for IPC ${channelId}: ${(destroyErr as Error).message}`);
        }
        
        
        discordConnections.delete(channelId);
        discordSocketLastUsed.delete(channelId);
        console.log(`Removed IPC ${channelId} from tracking after clearing presence`);
      }, 150);
    });
    
    if (!writeSuccess) {
      console.error(`Buffer full when writing to IPC ${channelId}, destroying socket immediately`);
      socket.destroy();
      discordConnections.delete(channelId);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error(`Error clearing presence for IPC ${channelId}: ${(err as Error).message}`);
    
    try {
      if (!socket.destroyed) {
        socket.destroy();
      }
    } catch (destroyErr) {
      console.error(`Error destroying socket for IPC ${channelId} after error: ${(destroyErr as Error).message}`);
    }
    
    discordConnections.delete(channelId);
    return false;
  }
}


function clearAllRichPresence() {
  console.log('Clearing all Discord rich presence...');
  
  
  let successCount = 0;
  let totalConnections = discordConnections.size;
  
  if (totalConnections === 0) {
    console.log('No active Discord connections to clear');
    return;
  }
  
  for (const [id, socket] of discordConnections.entries()) {
    try {
      if (socket.destroyed) {
        console.log(`Socket for IPC ${id} already destroyed, skipping`);
        continue;
      }
      
      
      const clearPresenceOp = 1; 
      const clearPresencePayload = JSON.stringify({
        cmd: 'SET_ACTIVITY',
        args: {
          pid: process.pid,
          activity: null
        },
        nonce: `clear-${Date.now()}`
      });
      
      
      const payloadBuffer = Buffer.from(clearPresencePayload, 'utf8');
      const messageBuffer = Buffer.alloc(8 + payloadBuffer.length);
      messageBuffer.writeInt32LE(payloadBuffer.length, 0);
      messageBuffer.writeInt32LE(clearPresenceOp, 4);
      payloadBuffer.copy(messageBuffer, 8);
      
      
      const writeSuccess = socket.write(messageBuffer, (err) => {
        if (err) {
          console.error(`Error during write completion for IPC ${id}: ${err.message}`);
        } else {
          successCount++;
          console.log(`Successfully sent clear presence to IPC ${id}`);
        }
        
        
        setTimeout(() => {
          try {
            if (!socket.destroyed) {
              socket.destroy();
            }
          } catch (destroyErr) {
            console.error(`Error destroying socket for IPC ${id}: ${(destroyErr as Error).message}`);
          }
          
          
          if (--totalConnections <= 0) {
            discordConnections.clear();
            discordSocketLastUsed.clear();
            console.log(`All Discord IPC connections handled. Success: ${successCount}/${discordConnections.size}`);
          }
        }, 150);
      });
      
      if (!writeSuccess) {
        console.error(`Buffer full when writing to IPC ${id}, destroying socket immediately`);
        socket.destroy();
      }
    } catch (err) {
      console.error(`Error clearing presence for IPC ${id}: ${(err as Error).message}`);
      
      try {
        if (!socket.destroyed) {
          socket.destroy();
        }
      } catch (destroyErr) {
        console.error(`Error destroying socket for IPC ${id} after error: ${(destroyErr as Error).message}`);
      }
      
      if (--totalConnections <= 0) {
        discordConnections.clear();
        discordSocketLastUsed.clear();
        console.log(`All Discord IPC connections handled. Success: ${successCount}/${discordConnections.size}`);
      }
    }
  }
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
}); 