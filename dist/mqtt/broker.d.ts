import { Server } from 'net';
type MessageHandler = (clientId: string, topic: string, payload: Record<string, unknown>) => void;
export declare function startBroker(onMessage: MessageHandler): Promise<Server>;
export {};
//# sourceMappingURL=broker.d.ts.map