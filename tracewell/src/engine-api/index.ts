// Public entry point of the engine-api module, imported elsewhere as '@tw/engine-api': the engine
// protocol, the client the UI holds, the transports and serve(), and the stub engine.

export type {
  EngineApi,
  EngineEvent,
  EngineImpl,
  EngineInfo,
  MessagePortLike,
  RpcEvent,
  RpcRequest,
  RpcResponse,
  Transport,
} from './protocol';
export { PROTOCOL_VERSION } from './protocol';
export type { ByteChannel } from './framing';
export { FrameDecoder, encodeFrame } from './framing';
export { inProcessTransport, portTransport, stdioTransport, workerTransport } from './transport';
export { serve, serveStdio } from './serve';
export { EngineClient } from './client';
export { createStubEngine } from './stub';
