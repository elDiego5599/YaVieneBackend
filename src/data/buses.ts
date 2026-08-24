// Barrel del dominio bus: los stores reales viven en módulos propios y
// este archivo conserva la ruta de import histórica ('../data/buses')
// para que API, sockets y tests no tengan que saber el reparto interno.
export * from './bus_types';
export * from './positions_store';
export * from './drivers_store';
export * from './routes_store';
export {
  loadVisibilityCache,
  loadBusCompanyCache,
  getBusCompanyId,
  getBusVisibility,
  getFleetPositions,
  createBus,
  updateBus,
  deleteBus,
  deleteAllBuses,
  normalizePlaca,
  busIdFromPlaca,
  getCompanyBuses,
  setBusVisibility,
  setAllBusVisibility,
} from './fleet_admin';
