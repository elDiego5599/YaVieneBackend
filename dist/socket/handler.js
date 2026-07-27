"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupSocketServer = setupSocketServer;
exports.broadcastBusPosition = broadcastBusPosition;
const socket_io_1 = require("socket.io");
const config_1 = require("../config");
const buses_1 = require("../data/buses");
let io = null;
function setupSocketServer(httpServer) {
    io = new socket_io_1.Server(httpServer, {
        path: config_1.WS_PATH,
        cors: { origin: '*', methods: ['GET', 'POST'] },
        pingInterval: 10000,
        pingTimeout: 5000,
    });
    io.on('connection', (socket) => {
        console.log(`[WS] Client connected: ${socket.id}`);
        socket.on('subscribe:route', (routeId) => {
            if (!routeId)
                return;
            socket.join(`route:${routeId}`);
            const positions = (0, buses_1.getPositionsByRoute)(routeId);
            socket.emit('positions:batch', { routeId, buses: positions });
        });
        socket.on('unsubscribe:route', (routeId) => {
            if (routeId)
                socket.leave(`route:${routeId}`);
        });
        socket.on('driver:register', ({ phoneNumber, name, routeId }) => {
            if (!phoneNumber || !routeId) {
                socket.emit('driver:error', { message: 'phoneNumber and routeId required' });
                return;
            }
            (0, buses_1.registerDriver)(phoneNumber, name || phoneNumber, routeId);
            socket.join(`route:${routeId}`);
            socket.data = { ...socket.data, driverPhone: phoneNumber, routeId };
            socket.emit('driver:registered', { phoneNumber, routeId });
        });
        socket.on('disconnect', () => {
            console.log(`[WS] Client disconnected: ${socket.id}`);
        });
    });
    return io;
}
function broadcastBusPosition(busData) {
    if (!io)
        return;
    io.to(`route:${busData.routeId}`).emit('bus:position', busData);
}
//# sourceMappingURL=handler.js.map