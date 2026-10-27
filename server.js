require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// Credenciais: FIREBASE_SERVICE_ACCOUNT com o JSON inteiro (Render/Railway)
// ou GOOGLE_APPLICATION_CREDENTIALS apontando para o arquivo (no PC).
const credential = process.env.FIREBASE_SERVICE_ACCOUNT
  ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  : applicationDefault();
initializeApp({ credential });

const db = getFirestore();
const app = express();
app.use(cors());
app.use(express.json({ limit: '16kb' }));

// Exige o login anônimo do app: bloqueia chamadas que não vêm do app.
async function requireUser(req, res, next) {
  const match = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = await getAuth().verifyIdToken(match[1]);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/send', requireUser, async (req, res) => {
  const { groupCode, deviceIds, title, body, fromDeviceId } = req.body || {};
  if (typeof groupCode !== 'string' || !/^[A-Z0-9]{8,32}$/.test(groupCode)) {
    return res.status(400).json({ error: 'groupCode inválido' });
  }
  if (!Array.isArray(deviceIds) || deviceIds.length === 0 || deviceIds.length > 50) {
    return res.status(400).json({ error: 'deviceIds deve ter de 1 a 50 itens' });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'body é obrigatório' });
  }

  const devicesRef = db.collection('groups').doc(groupCode).collection('devices');
  const snaps = await db.getAll(...deviceIds.map((id) => devicesRef.doc(String(id))));

  const results = [];
  const targets = [];
  for (const snap of snaps) {
    const token = snap.exists && snap.get('token');
    if (!token) results.push({ deviceId: snap.id, ok: false, error: 'aparelho não encontrado' });
    else targets.push({ deviceId: snap.id, token });
  }

  if (targets.length) {
    // Uma mensagem separada por aparelho, com resultado individual.
    const messages = targets.map(({ token }) => ({
      token,
      notification: { title: String(title || 'Nova mensagem').slice(0, 200), body: body.slice(0, 2000) },
      data: { fromDeviceId: String(fromDeviceId || '') },
      android: { priority: 'high', notification: { channelId: 'mensagens' } },
    }));
    const { responses } = await getMessaging().sendEach(messages);

    await Promise.all(responses.map(async (r, i) => {
      const { deviceId } = targets[i];
      if (r.success) return results.push({ deviceId, ok: true });
      const code = r.error?.code || 'erro';
      results.push({ deviceId, ok: false, error: code });
      // Token morto (app desinstalado etc.): tira o aparelho da lista.
      if (code === 'messaging/registration-token-not-registered') {
        await devicesRef.doc(deviceId).delete();
      }
    }));
  }

  res.json({ results });
});

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Backend ouvindo na porta ${port}`));
