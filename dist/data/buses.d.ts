export interface BusPosition {
    busId: string;
    routeId: string;
    lat: number;
    lon: number;
    heading: number;
    speedKmh: number;
    timestamp: string;
    driverPhone: string;
    isGhost: boolean;
}
interface DriverInfo {
    name: string;
    routeId: string;
    registeredAt: string;
}
export declare function upsertPosition(phoneNumber: string, data: {
    busId: string;
    routeId?: string;
    lat: number;
    lon: number;
    heading?: number;
    speedKmh?: number;
}): BusPosition | null;
export declare function getPositionsByRoute(routeId: string): BusPosition[];
export declare function getPosition(busId: string): BusPosition | null;
export declare function getAllPositions(): BusPosition[];
export declare function registerDriver(phoneNumber: string, name: string, routeId: string): DriverInfo;
export declare function getDriver(phoneNumber: string): DriverInfo | null;
export {};
//# sourceMappingURL=buses.d.ts.map