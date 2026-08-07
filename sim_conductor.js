const mqtt = require('mqtt');

const BASE = 'http://127.0.0.1:3000';
const PHONE = process.argv[2] || '3000000000';
const PASSWORD = process.argv[3] || '1234';

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: PHONE, pin: PASSWORD }),
  });
  const body = await login.json();
  if (!login.ok) {
    console.error('LOGIN FAILED', login.status, body);
    process.exit(1);
  }
  const token = body.token || body.jwt || body.data?.token;
  const sessionId = body.sessionId || body.data?.sessionId || body.tokenData?.sessionId;
  if (!token) {
    console.error('No token in login response:', JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }
  const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  console.log('Login OK:', decoded.phoneNumber, 'bus', decoded.busId, 'route', decoded.routeId, 'session', decoded.sessionId || sessionId);

  const client = mqtt.connect('mqtt://127.0.0.1:8883', {
    username: decoded.phoneNumber,
    password: token,
    clientId: `sim_${decoded.busId}_${Date.now()}`,
    keepalive: 15,
    clean: true,
  });
  const ackTopic = `empresa/${decoded.companyId}/bus/${decoded.busId}/ack`;
  const posTopic = `empresa/${decoded.companyId}/bus/${decoded.busId}/posicion`;

  client.on('error', (err) => console.error('MQTT error:', err.message));
  client.on('connect', () => {
    console.log('MQTT connected');
    client.subscribe(ackTopic, { qos: 0 }, (err) => {
      if (err) console.error('sub err', err);
    });
    client.on('message', (t, payload) => {
      const ack = JSON.parse(payload.toString());
      console.log('ACK:', JSON.stringify(ack));
    });

    const lat0 = 10.99015, lon0 = -74.7909;
    let seq = 0;
    const publish = () => {
      seq += 1;
      const t = seq * 12;
      const lat = lat0 + (t / 1000) * 0.00009;
      const lon = lon0 + (t / 1000) * 0.00011;
      const payload = JSON.stringify({
        protocolVersion: 1,
        sequence: seq,
        capturedAt: Date.now(),
        lat,
        lon,
        speedKmh: 32,
      });
      client.publish(posTopic, payload, { qos: 0 });
      console.log('Published position', seq, lat.toFixed(6), lon.toFixed(6));
    };
    publish();
    const iv = setInterval(publish, 12000);
    setTimeout(() => {
      clearInterval(iv);
      client.end();
      console.log('Sim done');
      process.exit(0);
    }, 26000);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
