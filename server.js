const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { execFile } = require('child_process');
const OpenAI = require('openai');
const bcrypt = require('bcrypt');
const db = require('./db');
const { generateToken, authMiddleware } = require('./auth');
require('dotenv').config();

const execFileAsync = util.promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠ OPENAI_API_KEY não encontrada no .env');
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json());

// raiz sempre entra pelo portal
app.get('/', (req, res) => {
  return res.redirect('/portal/');
});

// arquivos estáticos depois do redirect da raiz
app.use(express.static(path.join(__dirname, 'public')));

// ========================
// PESOS OFICIAIS
// ========================
const WEIGHTS = {
  Gancho: 15,
  Roteiro: 15,
  'Potencial de vendas': 10,
  CTA: 10,
  Clareza: 15,
  Apresentação: 10,
  Edição: 10,
  'Qualidade do vídeo': 10,
  Ambiente: 5
};

// ========================
// UTIL
// ========================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir('uploads');
ensureDir('frames');
ensureDir('public');

async function getDuration(video) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    video
  ]);

  const duration = parseFloat(stdout.trim());

  if (!duration || Number.isNaN(duration)) {
    throw new Error(`Não foi possível obter a duração do vídeo: ${video}`);
  }

  return duration;
}

function cleanupFiles(files = []) {
  for (const file of files) {
    try {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {
      console.warn('Falha ao remover arquivo:', file, e.message);
    }
  }
}

function extractTextFromResponse(res) {
  if (res.output_text && String(res.output_text).trim()) {
    return String(res.output_text).trim();
  }

  if (Array.isArray(res.output)) {
    const texts = [];

    for (const item of res.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) {
            texts.push(c.text);
          }
        }
      }
    }

    if (texts.length) {
      return texts.join('\n').trim();
    }
  }

  return '';
}

function sanitizeJsonText(text) {
  if (!text) return '';

  let cleaned = text.trim();

  cleaned = cleaned.replace(/^```json\s*/i, '');
  cleaned = cleaned.replace(/^```\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/i, '');

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return cleaned.trim();
}

function toNumberInRange(value, min = 0, max = 100) {
  let num = Number(value);

  if (Number.isNaN(num)) return 0;

  if (num <= 10) {
    num = num * 10;
  }

  return Math.max(min, Math.min(max, num));
}

function normalizeCriteria(criteria = {}, scriptScore = 0) {
  return {
    Ambiente: toNumberInRange(criteria.Ambiente),
    Apresentação: toNumberInRange(criteria.Apresentação),
    'Potencial de vendas': toNumberInRange(criteria['Potencial de vendas']),
    Clareza: toNumberInRange(criteria.Clareza),
    Edição: toNumberInRange(criteria.Edição),
    'Qualidade do vídeo': toNumberInRange(criteria['Qualidade do vídeo']),
    Gancho: toNumberInRange(criteria.Gancho),
    CTA: toNumberInRange(criteria.CTA),
    Roteiro: toNumberInRange(
      criteria.Roteiro != null ? criteria.Roteiro : scriptScore
    )
  };
}

function calculateFinalScore(criteria) {
  let total = 0;

  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const criterionScore = toNumberInRange(criteria[key]);
    total += criterionScore * (weight / 100);
  }

  return Math.round(total);
}

function classifyResult(score, criteria) {
  const videoQuality = toNumberInRange(criteria['Qualidade do vídeo']);
  const editing = toNumberInRange(criteria['Edição']);
  const hook = toNumberInRange(criteria['Gancho']);
  const script = toNumberInRange(criteria['Roteiro']);
  const clarity = toNumberInRange(criteria['Clareza']);

  let result = 'REPROVADO';

  if (score >= 90) {
    result = 'APROVADO';
  } else if (score >= 70) {
    result = 'APROVADO COM AJUSTES';
  }

  if (result === 'APROVADO') {
    if (videoQuality < 50 || editing < 50 || hook < 60 || script < 60 || clarity < 60) {
      result = 'APROVADO COM AJUSTES';
    }
  }

  return result;
}

function normalizeAnalysis(parsed, transcript) {
  const scriptScore = toNumberInRange(parsed.script_score);
  const criteriaScores = normalizeCriteria(parsed.criteria_scores || {}, scriptScore);
  const finalScore = calculateFinalScore(criteriaScores);
  const finalResult = classifyResult(finalScore, criteriaScores);

  return {
    status: 'analysis_ok',
    resultado: finalResult,
    score: finalScore,
    summary: parsed.summary || '',
    transcript_full: parsed.transcript_full || transcript || '',
    script_score: criteriaScores.Roteiro,
    script_analysis: parsed.script_analysis || '',
    instagram_caption: parsed.instagram_caption || '',
    criteria_scores: criteriaScores,
    weights: WEIGHTS,
    positives: Array.isArray(parsed.positives) ? parsed.positives : [],
    negatives: Array.isArray(parsed.negatives) ? parsed.negatives : [],
    adjustments: Array.isArray(parsed.adjustments) ? parsed.adjustments : []
  };
}

// ========================
// HEALTH
// ========================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    openaiKeyLoaded: !!process.env.OPENAI_API_KEY
  });
});

app.get('/health/openai', async (req, res) => {
  try {
    const test = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: 'Responda apenas com OK'
    });

    res.json({
      status: 'ok',
      openai: test.output_text || '(sem output_text)'
    });
  } catch (e) {
    console.error('Erro /health/openai:', e);
    res.status(500).json({
      error: e.message,
      details: e.response?.data || null
    });
  }
});

// ========================
// AUTH
// ========================
app.post('/register', async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    const hash = await bcrypt.hash(password, 10);

    db.run(
      'INSERT INTO users (email, password) VALUES (?, ?)',
      [email, hash],
      function (err) {
        if (err) {
          return res.status(400).json({ error: 'Usuário já existe' });
        }

        return res.json({
          ok: true,
          user: {
            id: this.lastID,
            email
          }
        });
      }
    );
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao registrar usuário' });
  }
});

app.post('/login', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }

  db.get(
    'SELECT * FROM users WHERE email = ?',
    [email],
    async (err, user) => {
      if (err) {
        return res.status(500).json({ error: 'Erro ao buscar usuário' });
      }

      if (!user) {
        return res.status(401).json({ error: 'Usuário não encontrado' });
      }

      const valid = await bcrypt.compare(password, user.password);

      if (!valid) {
        return res.status(401).json({ error: 'Senha inválida' });
      }

      const token = generateToken(user);

      return res.json({
        token,
        user: {
          id: user.id,
          email: user.email
        }
      });
    }
  );
});

app.get('/me', authMiddleware, (req, res) => {
  res.json({
    user: req.user
  });
});

// ========================
// UPLOAD
// ========================
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Apenas vídeos são permitidos'));
  }
});

// ========================
// FRAMES
// ========================
async function extractFrames(video) {
  console.log('🎞 Extraindo frames do vídeo:', video);

  const duration = await getDuration(video);
  const name = path.parse(video).name;
  const dir = path.join('frames', name);

  ensureDir(dir);

  const points = [0.1, 0.3, 0.5, 0.7, 0.9];
  const frames = [];

  for (let i = 0; i < points.length; i++) {
    const t = duration * points[i];
    const out = path.join(dir, `f${i}.jpg`);

    await execFileAsync('ffmpeg', [
      '-y',
      '-ss', String(t),
      '-i', video,
      '-frames:v', '1',
      '-q:v', '2',
      out
    ]);

    if (fs.existsSync(out)) frames.push(out);
  }

  console.log(`✅ Frames extraídos: ${frames.length}`);
  return frames;
}

// ========================
// AUDIO
// ========================
async function extractAudio(video, audio) {
  console.log('🎧 Extraindo áudio...');
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', video,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    audio
  ]);
  console.log('✅ Áudio extraído:', audio);
}

// ========================
// TRANSCRIÇÃO
// ========================
async function transcribe(audio) {
  console.log('📝 Iniciando transcrição...');

  const result = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audio),
    model: 'gpt-4o-mini-transcribe',
    language: 'pt'
  });

  const text = result.text || '';

  console.log('✅ Transcrição concluída');
  console.log('Transcrição (primeiros 300 chars):', text.slice(0, 300));
  console.log('Transcrição tamanho final:', text.length);

  return text;
}

// ========================
// ANALISE
// ========================
function img64(filePath) {
  return `data:image/jpeg;base64,${fs.readFileSync(filePath, 'base64')}`;
}

async function analyze(frames, transcript) {
  console.log('🤖 Iniciando análise IA...');
  console.log('Frames enviados:', frames.length);
  console.log('Transcrição tamanho:', transcript ? transcript.length : 0);
  console.log('OPENAI_API_KEY carregada?', !!process.env.OPENAI_API_KEY);

  const content = [
    {
      type: 'input_text',
      text: `
Você é especialista em análise de vídeos de marketing com foco em vendas e qualidade visual.

Analise as imagens e a transcrição completa do vídeo.

Responda SOMENTE com JSON válido.
Não use markdown.
Não use crases.
Não escreva texto antes ou depois do JSON.

Você deve avaliar o vídeo com equilíbrio entre:
- capacidade de vender
- clareza da comunicação
- qualidade visual e percepção profissional

Escala oficial do sistema:
- todas as notas devem ir de 0 a 100
- 0 a 69 = REPROVADO
- 70 a 89 = APROVADO COM AJUSTES
- 90 a 100 = APROVADO

Critérios obrigatórios:
- Ambiente
- Apresentação
- Potencial de vendas
- Clareza
- Edição
- Qualidade do vídeo
- Gancho
- CTA
- Roteiro

Pesos oficiais:
- Gancho: 15
- Roteiro: 15
- Potencial de vendas: 10
- CTA: 10
- Clareza: 15
- Apresentação: 10
- Edição: 10
- Qualidade do vídeo: 10
- Ambiente: 5

Regras:
- Não aprove totalmente vídeos visualmente ruins.
- Se edição ou qualidade do vídeo forem baixas, o vídeo deve exigir ajustes.
- O roteiro deve considerar força comercial, persuasão, clareza, fluidez, objeções e CTA.
- A legenda do Instagram deve vir pronta para postar, com copy forte, natural, comercial e CTA final.
- Retorne todos os critérios obrigatoriamente.
- Todos os critérios devem ser números inteiros.
- script_score deve ser coerente com Roteiro.
- transcript_full deve ser a transcrição completa, limpa e organizada.

Formato obrigatório:
{
  "summary": "Resumo breve da análise geral",
  "transcript_full": "Transcrição completa revisada do vídeo",
  "script_score": 0,
  "script_analysis": "Análise objetiva do roteiro com base na transcrição",
  "instagram_caption": "Legenda pronta para Instagram",
  "criteria_scores": {
    "Ambiente": 0,
    "Apresentação": 0,
    "Potencial de vendas": 0,
    "Clareza": 0,
    "Edição": 0,
    "Qualidade do vídeo": 0,
    "Gancho": 0,
    "CTA": 0,
    "Roteiro": 0
  },
  "positives": ["ponto 1", "ponto 2"],
  "negatives": ["ponto 1", "ponto 2"],
  "adjustments": ["ajuste 1", "ajuste 2"]
}

Transcrição completa do vídeo:
${transcript || 'Sem transcrição disponível.'}
`
    }
  ];

  frames.forEach((f) => {
    content.push({
      type: 'input_image',
      image_url: img64(f)
    });
  });

  const res = await openai.responses.create({
    model: 'gpt-4.1',
    input: [{ role: 'user', content }]
  });

  console.log('✅ Resposta bruta da IA recebida');
  console.log('response.output_text:', res.output_text || '(vazio)');

  const rawText = extractTextFromResponse(res);
  const cleaned = sanitizeJsonText(rawText);

  console.log('Texto bruto extraído da IA:');
  console.log(rawText || '(sem texto)');

  console.log('Texto limpo para parse:');
  console.log(cleaned || '(sem texto limpo)');

  if (!cleaned) {
    throw new Error('A IA respondeu sem texto utilizável para parse.');
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('❌ Erro ao fazer JSON.parse da resposta da IA');
    console.error('Texto recebido:', cleaned);
    throw new Error(`Falha ao converter resposta da IA em JSON: ${e.message}`);
  }

  const normalized = normalizeAnalysis(parsed, transcript);

  console.log('✅ JSON da análise validado com sucesso');
  console.log(JSON.stringify(normalized, null, 2));

  return normalized;
}

// ========================
// ANALYZE
// ========================
app.post('/analyze', authMiddleware, upload.single('video'), async (req, res) => {
  const tempFiles = [];

  try {
    console.log('==============================');
    console.log('📥 Nova requisição /analyze');
    console.log('Usuário autenticado:', req.user.email);

    if (!req.file) {
      return res.status(400).json({ error: 'Sem vídeo' });
    }

    const video = req.file.path;
    const audio = `${video}.mp3`;

    tempFiles.push(audio);

    console.log('Arquivo recebido:', req.file.originalname);
    console.log('Path temporário:', video);

    const frames = await extractFrames(video);
    await extractAudio(video, audio);
    const transcript = await transcribe(audio);
    const analysis = await analyze(frames, transcript);

    console.log('✅ Processo concluído com sucesso');

    return res.json({
      ...analysis,
      transcript,
      frames
    });
  } catch (err) {
    console.error('❌ Erro em /analyze');
    console.error(err);
    console.error('Detalhes OpenAI:', err.response?.data || null);

    return res.status(500).json({
      error: err.message,
      details: err.response?.data || null
    });
  } finally {
    cleanupFiles(tempFiles);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});