const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const db = require('./db');
const { generateToken, authMiddleware } = require('./auth');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// ========================
// 🔥 REDIRECIONAMENTOS
// ========================
app.get('/', (req, res) => {
  return res.redirect('/portal/index.html');
});

app.get('/portal', (req, res) => {
  return res.redirect('/portal/index.html');
});

app.get('/portal/', (req, res) => {
  return res.redirect('/portal/index.html');
});

// ========================
// 🔥 ARQUIVOS ESTÁTICOS
// ========================
app.use(express.static(path.join(__dirname, 'public')));

// ========================
// AUTH
// ========================
app.post('/login', (req, res) => {
  const email = req.body.email;
  const password = req.body.password;

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Senha inválida' });

    const token = generateToken(user);
    res.json({ token, user });
  });
});

// ========================
// UPLOAD
// ========================
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 300 * 1024 * 1024 }
});

// ========================
// ANALYZE
// ========================
app.post('/analyze', authMiddleware, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Sem vídeo' });
    }

    // 🔥 Aqui depois você pode colocar OpenAI novamente
    return res.json({
      resultado: "APROVADO",
      score: 85,
      summary: "Exemplo de análise",
      script_score: 80,
      script_analysis: "Boa estrutura",
      instagram_caption: "Legenda exemplo",
      transcript_full: "Texto exemplo",
      positives: ["Boa iluminação"],
      negatives: ["Áudio médio"],
      adjustments: ["Melhorar CTA"],
      criteria_scores: {}
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========================
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});