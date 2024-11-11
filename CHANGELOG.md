### 0.3.1

- Add IPv6 support
- Add Node.js v18 support

### 0.3.0

- Support tunneling half-closed TCP connections, these are sometimes killed by middleboxes but they will be safe in h2tunnel
- Remove mux/demux port configuration, instead take a random port assigned by the OS
- Allow specifying the origin host for advanced use cases, default is localhost

### 0.2.0

- Tunnel TCP instead of HTTP1, supporting a wide range of protocols
- Prevent double TLS encryption by using Node.js unencrypted HTTP/2 connection
- Lots of testing improvements
- Reduce code size to <500 LOC

### 0.1.1

- Improved testing and reconnection logic

### 0.1.0

- Proof of concept
- Supports tunneling HTTP1 over HTTP/2 + TLS
