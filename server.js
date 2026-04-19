const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const db = require('./db');
const { generateToken } = require('./auth');
const OpenAI = require('openai');
require('dotenv').config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const publicPath = path.join(__dirname, 'public');
const uploadsPath = path.join(__dirname, 'uploads');
const framesPath = path.join(__dirname, 'frames');

if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
if (!fs.existsSync(framesPath)) fs.mkdirSync(framesPath, { recursive: true });

// ========================
// REDIRECIONAMENTOS
// ========================
app.get('/', (req, res) => res.redirect('/portal/index.html'));
app.get('/portal', (req, res) => res.redirect('/portal/index.html'));
app.get('/portal/', (req, res) => res.redirect('/portal/index.html'));

// ========================
// ARQUIVOS ESTÁTICOS
// ========================
app.use(express.static(publicPath));

// ========================
// AUTH
// ========================
app.post('/login', (req, res) => {
  const email = req.body.email;
  const password = req.body.password;

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) {
      console.error('Erro no login:', err);
      return res.status(500).json({ error: 'Erro interno no login' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Usuário não encontrado' });
    }

    const valid = await bcrypt.compare(password, user.password);

    if (!valid) {
      return res.status(401).json({ error: 'Senha inválida' });
    }

    const token = generateToken(user);
    return res.json({ token, user });
  });
});

// ========================
// HELPERS
// ========================
function scoreToResultado(score) {
  if (score >= 80) return 'APROVADO';
  if (score >= 60) return 'AJUSTAR';
  return 'REPROVADO';
}

function sanitizeFileName(name) {
  return String(name || 'video')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.\-]+/g, '_');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean);
}

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeScore(value, fallback = 60) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

// ========================
// UPLOAD COM EXTENSÃO REAL
// ========================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsPath);
  },
  filename: (req, file, cb) => {
    const originalExt = path.extname(file.originalname || '').toLowerCase();
    const safeBase = path.basename(
      sanitizeFileName(file.originalname || `video_${Date.now()}`),
      originalExt
    );
    const finalExt = originalExt || '.mp4';
    cb(null, `${Date.now()}_${safeBase}${finalExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }
});

// ========================
// ANALYZE COM IA
// ========================
app.post('/analyze', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Sem vídeo' });
    }

    console.log('🎥 Processando vídeo:', {
      originalname: req.file.originalname,
      savedAs: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path
    });

    const supportedExtensions = ['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac'];
    const currentExt = path.extname(req.file.path).toLowerCase();

    if (!supportedExtensions.includes(currentExt)) {
      return res.status(400).json({
        error: 'Formato de arquivo não suportado para transcrição',
        detalhe: `Extensão recebida: ${currentExt || 'sem extensão'}`
      });
    }

    // ========================
    // 1) TRANSCRIÇÃO
    // ========================
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: 'gpt-4o-transcribe',
      response_format: 'json'
    });

    const transcriptText = normalizeText(transcription?.text);

    if (!transcriptText) {
      return res.json({
        resultado: 'AJUSTAR',
        score: 60,
        summary: `O arquivo "${req.file.originalname}" foi enviado, mas a transcrição retornou vazia.`,
        script_analysis: 'Não foi possível extrair fala suficiente do conteúdo para uma análise textual robusta.',
        instagram_caption: 'Vídeo recebido. Ajuste áudio, dicção ou clareza da fala para gerar uma legenda melhor.',
        transcript_full: 'Sem transcrição detectada.',
        positives: ['Upload concluído com sucesso.'],
        negatives: ['A IA não identificou fala suficiente para transcrever.'],
        adjustments: [
          'Verifique se o vídeo possui áudio audível.',
          'Teste com um vídeo com fala mais clara.',
          'Evite ruído excessivo e trilha muito alta.'
        ]
      });
    }

    // ========================
    // 2) ANÁLISE DE MARKETING MELHORADA
    // ========================
    const analysisPrompt = `
Você é um analista sênior de marketing de performance, copywriting e criativos para anúncios em vídeo.

Sua tarefa é avaliar a transcrição de um vídeo comercial com rigor profissional, pensando em conversão, retenção e força de venda.

Responda APENAS em JSON válido.
Não use markdown.
Não use crases.
Não escreva nenhum texto fora do JSON.

Formato obrigatório:
{
  "score": 0,
  "resumo": "",
  "hook": "",
  "retencao": "",
  "cta": "",
  "clareza": "",
  "emocao": "",
  "oferta": "",
  "script_analysis": "",
  "instagram_caption": "",
  "pontos_positivos": [],
  "pontos_negativos": [],
  "ajustes": []
}

Critérios de avaliação:
1. Hook
- o começo prende atenção?
- abre com promessa, dor, benefício, curiosidade ou impacto?
- se começar morno, pontue isso

2. Retenção
- o texto mantém interesse até o final?
- há fluidez ou fica repetitivo e previsível?
- avalie se o vídeo tende a segurar atenção

3. Clareza
- dá para entender rapidamente o que está sendo vendido?
- o benefício está claro?
- a comunicação é simples e direta?

4. Emoção e persuasão
- existe desejo, urgência, escassez, segurança, prova, autoridade ou benefício concreto?
- se estiver muito informativo e pouco persuasivo, diga isso

5. Oferta
- a proposta comercial está forte?
- há vantagem competitiva, estoque, condição, diferenciação ou argumento de compra?

6. CTA
- a chamada para ação é clara, forte e orientada à ação?
- ou está fraca/genérica?

Regras importantes:
- score deve ser inteiro de 0 a 100
- seja crítico e realista, não bonzinho
- o resumo deve ser objetivo
- script_analysis deve ser uma análise estratégica, profissional e útil
- instagram_caption deve ser uma legenda de Instagram em português do Brasil com foco comercial
- a legenda deve ter 2 blocos curtos
- a legenda deve soar natural, humana e forte para vendas
- a legenda deve destacar benefício, confiança e ação
- a legenda pode usar 1 ou 2 emojis no máximo
- a legenda não pode ficar genérica
- a legenda não pode usar hashtags
- a legenda deve terminar com CTA claro
- pontos_positivos e pontos_negativos devem ser objetivos
- ajustes devem ser práticos, específicos e acionáveis
- responda em português do Brasil

Guia de nota:
- 90 a 100 = peça muito forte para conversão
- 80 a 89 = boa, mas ainda pode otimizar
- 60 a 79 = aproveitável, porém precisa ajustes relevantes
- abaixo de 60 = fraca comercialmente

Transcrição do vídeo:
${transcriptText}
`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: 'Você responde apenas com JSON válido e consistente.'
        },
        {
          role: 'user',
          content: analysisPrompt
        }
      ]
    });

    const rawContent = completion?.choices?.[0]?.message?.content || '';
    const aiData = safeJsonParse(rawContent);

    if (!aiData) {
      console.error('❌ JSON inválido da IA:', rawContent);

      return res.json({
        resultado: 'AJUSTAR',
        score: 60,
        summary: 'A transcrição foi concluída, mas a resposta analítica não veio em JSON válido.',
        script_analysis: 'Foi possível transcrever o vídeo, porém houve falha na estrutura da resposta analítica.',
        instagram_caption: 'Produto certo, comunicação clara e estoque pronto para atender. Fale com a equipe e abasteça agora.',
        transcript_full: transcriptText,
        positives: ['Transcrição gerada com sucesso.'],
        negatives: ['Falha ao estruturar a análise da IA.'],
        adjustments: [
          'Tentar novamente a análise.',
          'Revisar o prompt da camada analítica.'
        ]
      });
    }

    const finalScore = normalizeScore(aiData.score, 60);

    const hookText = normalizeText(aiData.hook, 'Não informado');
    const retencaoText = normalizeText(aiData.retencao, 'Não informada');
    const ctaText = normalizeText(aiData.cta, 'Não informado');
    const clarezaText = normalizeText(aiData.clareza, 'Não informada');
    const emocaoText = normalizeText(aiData.emocao, 'Não informada');
    const ofertaText = normalizeText(aiData.oferta, 'Não informada');

    const positives = normalizeArray(aiData.pontos_positivos);
    const negatives = normalizeArray(aiData.pontos_negativos);
    const adjustments = normalizeArray(aiData.ajustes);

    return res.json({
      resultado: scoreToResultado(finalScore),
      score: finalScore,
      summary: normalizeText(aiData.resumo, 'Análise concluída com IA.'),
      script_analysis: normalizeText(
        aiData.script_analysis,
        `Hook: ${hookText} | Retenção: ${retencaoText} | CTA: ${ctaText} | Clareza: ${clarezaText} | Emoção: ${emocaoText} | Oferta: ${ofertaText}`
      ),
      instagram_caption: normalizeText(
        aiData.instagram_caption,
        'Qualidade, disponibilidade e confiança para não deixar sua venda parar. Fale com a equipe e abasteça agora.'
      ),
      transcript_full: transcriptText,
      positives,
      negatives,
      adjustments
    });
  } catch (err) {
    console.error('❌ ERRO IA:', err);

    return res.status(500).json({
      error: 'Erro na análise com IA',
      detalhe: err?.message || 'Falha interna'
    });
  }
});

// ========================
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
