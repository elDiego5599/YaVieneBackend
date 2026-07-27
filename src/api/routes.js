const { getAllPositions, getDriver } = require('../data/buses');

const companies = [
  { id: '1', name: 'Coolitoral S.A.' },
  { id: '2', name: 'Metrocaribe Ltda.' },
  { id: '3', name: 'Transcaribe S.A.S.' },
];

const allRoutes = {
  '1': [
    { id: '101', name: 'Ruta 1 - Centro/Soledad', companyId: '1' },
    { id: '102', name: 'Ruta 2 - Murillo/Terminal', companyId: '1' },
  ],
  '2': [
    { id: '201', name: 'Ruta 5 - Riomar/Abello', companyId: '2' },
  ],
  '3': [
    { id: '301', name: 'Troncal - Portal/Caribe', companyId: '3' },
  ],
};

function setupAPI(app) {
  app.get('/api/health', (_, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.get('/api/companies', (_, res) => {
    res.json(companies);
  });

  app.get('/api/companies/:id/routes', (req, res) => {
    const routes = allRoutes[req.params.id] ?? [];
    res.json(routes);
  });

  app.get('/api/routes/:routeId/positions', (req, res) => {
    const { getPositionsByRoute } = require('../data/buses');
    const positions = getPositionsByRoute(req.params.routeId);
    res.json({ routeId: req.params.routeId, buses: positions });
  });

  app.get('/api/buses/:busId', (req, res) => {
    const { getPosition } = require('../data/buses');
    const bus = getPosition(req.params.busId);
    if (!bus) return res.status(404).json({ error: 'Bus not found' });
    res.json(bus);
  });

  app.get('/api/drivers/:phone', (req, res) => {
    const driver = getDriver(req.params.phone);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    res.json(driver);
  });
}

module.exports = { setupAPI };
