Utility to pass RPC information from virtual/physical machines to another machine. 
This works by creating fake Discord IPC channels on the client and forwarding messages to your main PC via a websocket.  
  
Just run the client on your desired machine and run the server on the machine where discord is installed.

## Building

```bash
bun run build
```

## Running

### Quick Start

1. Configure your IP in config.json
2. Run server on your main PC
3. Run client on other machines

### Development

```bash
# Run the server
bun run server

# Run the client
bun run client

# Update configuration
bun run config
```
