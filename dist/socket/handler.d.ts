import { Server as HTTPServer } from 'http';
import { Server } from 'socket.io';
import { BusPosition } from '../data/buses';
export declare function setupSocketServer(httpServer: HTTPServer): Server;
export declare function broadcastBusPosition(busData: BusPosition): void;
//# sourceMappingURL=handler.d.ts.map