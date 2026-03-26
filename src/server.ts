import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import express from 'express';
import {
  ARC, VerID, OpenProduct,
  OpenProductStandplaatsvergunning, OpenProductOverlijdensakte,
  InMemory,
} from '@gemeentenijmegen/attestatie-registratie-component';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadFlowsConfig(): Record<string, { flowUuid: string }> {
  const configPath = path.resolve(process.env.FLOWS_CONFIG_PATH ?? './flows.json');
  const stat = fs.existsSync(configPath) ? fs.statSync(configPath) : null;
  if (!stat || !stat.isFile()) {
    throw new Error(
      `Flows config not found at: ${configPath}\n` +
      'Run: cp flows.example.json flows.json  — then fill in your VerID flow UUIDs.',
    );
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Fake OpenProduct server (used when OPENPRODUCT_MODE=fake)
// ---------------------------------------------------------------------------

const FAKE_PRODUCTS: Record<string, unknown> = {
  '12126e1e-9bc1-4a30-b73e-5b5aa4ce8bc4': {
    uuid: '12126e1e-9bc1-4a30-b73e-5b5aa4ce8bc4',
    url: 'http://localhost:9876/producten/12126e1e-9bc1-4a30-b73e-5b5aa4ce8bc4',
    naam: 'Vergunning langs de 4-daagse route',
    start_datum: '2026-01-20',
    eind_datum: '2026-01-31',
    aanmaak_datum: '2026-01-19T14:51:20.505685+01:00',
    update_datum: '2026-01-19T14:51:20.505699+01:00',
    producttype: {
      uuid: 'e9522583-d61f-4232-8268-d1596a94bf2d',
      code: 'TEST-4D',
      uniforme_product_naam: 'standplaatsvergunning',
    },
    eigenaren: [{ uuid: '1dbe98d5-118e-4143-8e24-f5c866efc799', bsn: '999999333' }],
    dataobject: { location: 'St. Annastraat 250 6525 HA NIJMEGEN' },
  },
  '341bd5ac-6a68-4ac2-812e-b9e4f4aea764': {
    uuid: '341bd5ac-6a68-4ac2-812e-b9e4f4aea764',
    url: 'http://localhost:9876/producten/341bd5ac-6a68-4ac2-812e-b9e4f4aea764',
    naam: 'Overlijdensakte test',
    start_datum: null,
    eind_datum: null,
    aanmaak_datum: '2026-03-24T11:24:24.042924+01:00',
    update_datum: '2026-03-24T11:24:24.042940+01:00',
    producttype: {
      uuid: '16ac80c5-c10d-4efd-9be0-d81966772aa6',
      code: 'TEST-PINK',
      uniforme_product_naam: 'overlijdensakte',
    },
    eigenaren: [{ uuid: '31411e0a-c87a-4d39-b328-c71361951ec8', bsn: '999999333' }],
    dataobject: {
      straat: 'Kerkstraat',
      gemeente: 'Utrecht',
      geslacht: 'Man',
      postcode: '1234 AB',
      voornamen: 'Hendrik Jan',
      achternaam: 'Berg',
      akteNummer: '2024-BS-000892',
      huisnummer: '42-A',
      woonplaats: 'Utrecht',
      voorletters: 'H.J.',
      voorvoegsel: 'van der',
      geboorteNaam: 'Vermeulen',
      geboortedatum: '1945-03-12',
      overlijdensdatum: '2024-02-28',
      relatieTotOverledene: 'Ouder',
    },
  },
};

function startFakeOpenProduct(port: number): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Handle PATCH (write-back) silently — just acknowledge
      if (req.method === 'PATCH') {
        console.log(`  [FakeOpenProduct] PATCH ${req.url} (acknowledged, not persisted)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      console.log(`  [FakeOpenProduct] ${req.method} ${req.url}`);
      const uuid = req.url?.split('/').pop();
      const product = uuid ? FAKE_PRODUCTS[uuid] : undefined;
      if (product) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(product));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Not found' }));
      }
    });
    server.listen(port, () => resolve({ server, baseUrl: `http://localhost:${port}` }));
    server.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const openProductMode = (process.env.OPENPRODUCT_MODE ?? 'fake').toLowerCase();
  const fakePort = parseInt(process.env.FAKE_OPENPRODUCT_PORT ?? '9876', 10);

  const flows = loadFlowsConfig();
  console.log(`Loaded flows: ${Object.keys(flows).join(', ')}`);

  // OpenProduct source setup
  let openProductBaseUrl: string;
  let openProductToken: string;

  if (openProductMode === 'fake') {
    const fake = await startFakeOpenProduct(fakePort);
    openProductBaseUrl = fake.baseUrl;
    openProductToken = 'fake-token';
    console.log(`\nFake OpenProduct API on ${openProductBaseUrl}`);
    console.log('Available products:');
    for (const [uuid, p] of Object.entries(FAKE_PRODUCTS)) {
      console.log(`  ${uuid}  ${(p as any).naam}`);
    }
  } else {
    openProductBaseUrl = requireEnv('OPENPRODUCT_BASE_URL');
    openProductToken = requireEnv('OPENPRODUCT_API_TOKEN');
    console.log(`Using real OpenProduct API at ${openProductBaseUrl}`);
  }

  // ARC instance
  const arc = new ARC({
    provider: new VerID(
      {
        issuerUri: requireEnv('VERID_ISSUER_URL'),
        redirectUri: requireEnv('ARC_CALLBACK_ENDPOINT'),
        clientSecret: requireEnv('VERID_CLIENT_SECRET'),
      },
      flows,
    ),
    store: new InMemory(),
    sources: [new OpenProduct({ baseUrl: openProductBaseUrl, apiToken: openProductToken })],
    attestations: [new OpenProductStandplaatsvergunning(), new OpenProductOverlijdensakte()],
  });

  arc.on('issuance', async (event) => {
    console.log(`[ARC] issuance → ${event.status}`, event.context);
  });

  // Express server
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // POST /start — begin issuance flow
  // Body: { id: string, source?: string }
  app.post('/start', async (req, res) => {
    try {
      const id: string | undefined = req.body?.id;
      const source: string = req.body?.source ?? 'openproduct';

      if (!id) {
        res.status(400).json({ error: 'Missing required field: id' });
        return;
      }

      console.log(`[POST /start] source=${source} id=${id}`);
      const result = await arc.issue({ source, id });

      if (result.type === 'oauth') {
        res.json({ url: result.url });
      } else {
        res.json(result);
      }
    } catch (err: any) {
      console.error('[POST /start] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /callback — OAuth redirect from VerID
  app.get('/callback', async (req, res) => {
    try {
      console.log('[GET /callback] query:', req.query);
      const searchParams = new URLSearchParams(
        Object.entries(req.query).map(([k, v]) => [k, String(v)]) as [string, string][],
      );
      const result = await arc.provider.callback(searchParams);

      const redirectBase = process.env.ARC_REDIRECT_URL ?? '/';
      const sep = redirectBase.includes('?') ? '&' : '?';
      res.redirect(302, `${redirectBase}${sep}status=${result.success}`);
    } catch (err: any) {
      console.error('[GET /callback] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(port, () => {
    console.log(`\nARC server running on http://localhost:${port}`);
    console.log('  POST /start     — begin issuance (body: { id, source? })');
    console.log('  GET  /callback  — OAuth redirect from VerID');
    console.log('  GET  /health    — health check\n');
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
