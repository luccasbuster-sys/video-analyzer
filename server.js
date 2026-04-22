const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { execFile } = require('child_process');
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
  if (score >= 61) return 'APROVADO COM AJUSTES';
  return 'REPROVADO TOTAL';
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

function normalizeStatus(value, score) {
  const status = String(value || '').trim().toUpperCase();
  const valid = ['REPROVADO TOTAL', 'APROVADO COM AJUSTES', 'APROVADO'];
  if (valid.includes(status)) return status;
  return scoreToResultado(score);
}

function ensureMinItems(items, minimum, fallbackItems) {
  const base = normalizeArray(items);
  const fallbacks = normalizeArray(fallbackItems);

  for (const item of fallbacks) {
    if (base.length >= minimum) break;
    if (!base.includes(item)) base.push(item);
  }

  while (base.length < minimum) {
    base.push('Ajuste estratégico adicional necessário para elevar a performance do vídeo.');
  }

  return base.slice(0, Math.max(minimum, base.length));
}

function getVideoName(file) {
  return normalizeText(file?.originalname, 'SEM IDENTIFICACAO');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function runExecFile(command, args = []) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function isFfmpegAvailable() {
  try {
    await runExecFile('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function extractFramesFromVideo(videoPath, fileNameBase) {
  const ffmpegAvailable = await isFfmpegAvailable();

  if (!ffmpegAvailable) {
    return {
      framePaths: [],
      visualNote: 'A análise visual não foi executada porque o ffmpeg não está disponível no sistema.'
    };
  }

  const frameDir = path.join(
    framesPath,
    `${Date.now()}_${sanitizeFileName(path.basename(fileNameBase, path.extname(fileNameBase)) || 'video')}`
  );

  ensureDir(frameDir);

  const outputPattern = path.join(frameDir, 'frame_%03d.jpg');

  try {
    await runExecFile('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-vf', "fps=1,scale='min(1024,iw)':-2",
      '-frames:v', '6',
      outputPattern
    ]);

    const files = fs.readdirSync(frameDir)
      .filter(name => /\.(jpg|jpeg|png)$/i.test(name))
      .sort()
      .slice(0, 6)
      .map(name => path.join(frameDir, name));

    if (!files.length) {
      return {
        framePaths: [],
        visualNote: 'Nenhum frame útil foi extraído para análise visual.'
      };
    }

    return {
      framePaths: files,
      visualNote: `Foram extraídos ${files.length} frame(s) para análise visual.`
    };
  } catch (error) {
    console.error('❌ Falha ao extrair frames:', error?.stderr || error?.message || error);
    return {
      framePaths: [],
      visualNote: 'A análise visual não foi concluída porque houve falha ao extrair frames do vídeo.'
    };
  }
}

function fileToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' :
    ext === '.webp' ? 'image/webp' :
    'image/jpeg';

  const base64 = fs.readFileSync(filePath, { encoding: 'base64' });
  return `data:${mime};base64,${base64}`;
}

async function analyzeVisualFrames(framePaths, videoName) {
  if (!Array.isArray(framePaths) || !framePaths.length) {
    return {
      resumo_visual: 'Análise visual indisponível.',
      observacoes_visuais: [],
      detalhamento_visual: 'Não houve frames disponíveis para leitura visual.'
    };
  }

  try {
    const content = [
      {
        type: 'text',
        text: `
Você é um especialista em análise de criativos em vídeo para performance, branding e prova social.

Analise apenas o aspecto visual dos frames enviados.
Considere:
- enquadramento
- legibilidade
- clareza visual da oferta
- presença de produto
- poluição visual
- ritmo percebido
- branding
- autoridade visual
- autenticidade
- prova visual real

Responda APENAS em JSON válido, sem markdown e sem texto fora do JSON.

Formato obrigatório:
{
  "resumo_visual": "",
  "observacoes_visuais": ["", "", "", "", ""],
  "detalhamento_visual": ""
}

Regras:
- responda em português do Brasil
- seja direto
- observacoes_visuais deve ter no mínimo 5 itens
- detalhamento_visual deve ser estratégico e prático
- o nome do vídeo é: ${videoName}
        `.trim()
      }
    ];

    for (const framePath of framePaths) {
      content.push({
        type: 'image_url',
        image_url: {
          url: fileToDataUrl(framePath)
        }
      });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'Você responde apenas com JSON válido.'
        },
        {
          role: 'user',
          content
        }
      ]
    });

    const raw = completion?.choices?.[0]?.message?.content || '';
    const parsed = safeJsonParse(raw);

    if (!parsed) {
      return {
        resumo_visual: 'A análise visual não retornou JSON válido.',
        observacoes_visuais: [],
        detalhamento_visual: 'Os frames foram enviados, mas a resposta visual não veio em formato estruturado.'
      };
    }

    return {
      resumo_visual: normalizeText(parsed.resumo_visual, 'Análise visual concluída.'),
      observacoes_visuais: ensureMinItems(parsed.observacoes_visuais, 5, [
        'A composição visual precisa reforçar melhor a mensagem principal.',
        'A leitura visual do criativo pode ficar mais direta.',
        'O enquadramento pode destacar mais o produto ou benefício.',
        'A hierarquia visual precisa favorecer a retenção.',
        'O impacto visual precisa sustentar melhor a proposta.'
      ]),
      detalhamento_visual: normalizeText(
        parsed.detalhamento_visual,
        'A análise visual foi executada, mas o detalhamento retornou de forma incompleta.'
      )
    };
  } catch (error) {
    console.error('❌ Erro na análise visual:', error?.message || error);
    return {
      resumo_visual: 'A análise visual falhou durante a chamada da IA.',
      observacoes_visuais: [],
      detalhamento_visual: 'Não foi possível concluir a leitura visual dos frames nesta execução.'
    };
  }
}

function getFallbackPositives(tipo) {
  const map = {
    comercial: [
      'A proposta do vídeo tem potencial comercial quando bem lapidada.',
      'Existe base para conversão se a comunicação ficar mais objetiva.',
      'O conteúdo apresenta elementos aproveitáveis para venda.',
      'Há oportunidade de melhorar a retenção sem reconstruir tudo.',
      'A peça tem estrutura suficiente para ser otimizada com ajustes.'
    ],
    institucional: [
      'Existe espaço para fortalecer autoridade da marca.',
      'A mensagem tem base para gerar percepção mais profissional.',
      'Há elementos visuais e narrativos que podem ser reaproveitados.',
      'A comunicação institucional pode evoluir sem perder identidade.',
      'A peça tem potencial de conexão quando a narrativa for refinada.'
    ],
    prova_social: [
      'O vídeo pode gerar confiança se a prova ficar mais explícita.',
      'Há base para transmitir autenticidade com ajustes pontuais.',
      'O material pode reforçar credibilidade com melhor estrutura.',
      'Existe potencial de validação real quando o resultado for melhor mostrado.',
      'A narrativa pode ganhar força com evidências mais claras.'
    ],
    geral: [
      'O vídeo possui base de comunicação aproveitável.',
      'Há elementos utilizáveis para evolução da peça.',
      'Existe potencial de melhoria com ajustes estratégicos.',
      'A estrutura atual permite otimização sem refazer tudo.',
      'O material pode performar melhor com correções bem direcionadas.'
    ]
  };

  return map[tipo] || map.geral;
}

function getFallbackNegatives(tipo) {
  const map = {
    comercial: [
      'O gancho inicial não está forte o suficiente para segurar atenção.',
      'A oferta pode estar pouco clara ou pouco destacada.',
      'A persuasão não conduz com firmeza para a ação.',
      'O CTA pode estar fraco, genérico ou pouco convincente.',
      'A construção de desejo precisa ficar mais evidente.'
    ],
    institucional: [
      'A narrativa da marca pode estar superficial ou pouco memorável.',
      'A conexão emocional pode estar fraca.',
      'A clareza da mensagem institucional pode melhorar.',
      'A construção de autoridade pode estar insuficiente.',
      'O vídeo pode não sustentar bem percepção de marca.'
    ],
    prova_social: [
      'A prova apresentada pode parecer fraca ou pouco concreta.',
      'A credibilidade pode estar abaixo do necessário.',
      'A identificação com o público pode estar limitada.',
      'O resultado mostrado pode não estar claro o suficiente.',
      'A autenticidade percebida pode estar comprometida.'
    ],
    geral: [
      'A execução ainda apresenta pontos críticos de performance.',
      'A mensagem pode estar menos clara do que deveria.',
      'A retenção pode cair por falta de impacto.',
      'A persuasão precisa de reforço.',
      'O vídeo ainda não entrega sua melhor versão.'
    ]
  };

  return map[tipo] || map.geral;
}

function normalizeEvaluationBlock(block, tipo) {
  const nota = normalizeScore(block?.nota, 60);
  return {
    nota,
    status: normalizeStatus(block?.status, nota),
    pontos_positivos: ensureMinItems(block?.pontos_positivos, 5, getFallbackPositives(tipo)),
    pontos_negativos: ensureMinItems(block?.pontos_negativos, 5, getFallbackNegatives(tipo)),
    explicacao_ajustes: normalizeText(
      block?.explicacao_ajustes,
      'Os pontos negativos reduzem retenção, conversão ou percepção de valor. Corrija o gancho, deixe a mensagem mais clara, aumente a força da prova e feche com CTA mais direto para melhorar o desempenho.'
    )
  };
}

function buildEvaluationText({ titulo, videoName, data }) {
  return [
    `${titulo}`,
    ``,
    `🎬 VIDEO ${videoName}`,
    ``,
    `NOTA: ${data.nota}`,
    `STATUS: ${data.status}`,
    ``,
    `✅ PONTOS POSITIVOS`,
    ...data.pontos_positivos.map(item => `- ${item}`),
    ``,
    `❌ PONTOS QUE DEVEM MUDAR`,
    ...data.pontos_negativos.map(item => `- ${item}`),
    ``,
    `🔧 EXPLICAÇÃO DOS AJUSTES`,
    data.explicacao_ajustes
  ].join('\n');
}

function buildCompleteAnalysisText({
  videoName,
  overall,
  comercial,
  institucional,
  provaSocial,
  visualSummary,
  visualDetails,
  transcriptSummary
}) {
  const generalBlock = [
    `🎬 VIDEO ${videoName}`,
    ``,
    `NOTA: ${overall.nota}`,
    `STATUS: ${overall.status}`,
    ``,
    `✅ PONTOS POSITIVOS`,
    ...overall.pontos_positivos.map(item => `- ${item}`),
    ``,
    `❌ PONTOS QUE DEVEM MUDAR`,
    ...overall.pontos_negativos.map(item => `- ${item}`),
    ``,
    `🔧 EXPLICAÇÃO DOS AJUSTES`,
    overall.explicacao_ajustes,
    ``,
    `🧾 PRECISÃO DA TRANSCRIÇÃO`,
    transcriptSummary,
    ``,
    `🖼️ LEITURA VISUAL`,
    visualSummary,
    ``,
    `📌 DETALHAMENTO VISUAL`,
    visualDetails
  ].join('\n');

  return [
    generalBlock,
    '',
    buildEvaluationText({
      titulo: '🟠 AVALIAÇÃO COMERCIAL (VENDAS)',
      videoName,
      data: comercial
    }),
    '',
    buildEvaluationText({
      titulo: '🔵 AVALIAÇÃO INSTITUCIONAL (MARCA)',
      videoName,
      data: institucional
    }),
    '',
    buildEvaluationText({
      titulo: '🟢 AVALIAÇÃO PROVA SOCIAL',
      videoName,
      data: provaSocial
    })
  ].join('\n\n');
}

function getModeMeta(mode) {
  const map = {
    completo: {
      label: 'Completo',
      title: 'ANÁLISE COMPLETA',
      evaluationKey: 'geral'
    },
    comercial: {
      label: 'Comercial (Vendas)',
      title: '🟠 AVALIAÇÃO COMERCIAL (VENDAS)',
      evaluationKey: 'comercial'
    },
    institucional: {
      label: 'Institucional (Marca)',
      title: '🔵 AVALIAÇÃO INSTITUCIONAL (MARCA)',
      evaluationKey: 'institucional'
    },
    prova_social: {
      label: 'Prova Social',
      title: '🟢 AVALIAÇÃO PROVA SOCIAL',
      evaluationKey: 'prova_social'
    }
  };

  return map[mode] || map.completo;
}

function buildSingleModeAnalysisText({
  mode,
  videoName,
  evaluation,
  transcriptSummary,
  visualSummary,
  visualDetails
}) {
  const meta = getModeMeta(mode);

  return [
    `${meta.title}`,
    ``,
    `🎬 VIDEO ${videoName}`,
    ``,
    `NOTA: ${evaluation.nota}`,
    `STATUS: ${evaluation.status}`,
    ``,
    `✅ PONTOS POSITIVOS`,
    ...evaluation.pontos_positivos.map(item => `- ${item}`),
    ``,
    `❌ PONTOS QUE DEVEM MUDAR`,
    ...evaluation.pontos_negativos.map(item => `- ${item}`),
    ``,
    `🔧 EXPLICAÇÃO DOS AJUSTES`,
    evaluation.explicacao_ajustes,
    ``,
    `🧾 PRECISÃO DA TRANSCRIÇÃO`,
    transcriptSummary,
    ``,
    `🖼️ LEITURA VISUAL`,
    visualSummary,
    ``,
    `📌 DETALHAMENTO VISUAL`,
    visualDetails
  ].join('\n');
}

function buildResponsePayload({
  mode,
  videoName,
  summary,
  transcriptText,
  transcriptSummary,
  visualAnalysis,
  selectedModeLabel,
  overall,
  comercial,
  institucional,
  provaSocial,
  instagramCaption
}) {
  if (mode === 'completo') {
    const finalAnalysisText = buildCompleteAnalysisText({
      videoName,
      overall,
      comercial,
      institucional,
      provaSocial,
      visualSummary: normalizeText(visualAnalysis.resumo_visual, 'Leitura visual concluída.'),
      visualDetails: normalizeText(visualAnalysis.detalhamento_visual, 'Sem detalhamento visual adicional.'),
      transcriptSummary
    });

    return {
      resultado: overall.status,
      score: overall.nota,
      summary,
      script_analysis: finalAnalysisText,
      instagram_caption: instagramCaption,
      transcript_full: transcriptText,
      positives: overall.pontos_positivos,
      negatives: overall.pontos_negativos,
      adjustments: [overall.explicacao_ajustes],
      visual_analysis_summary: normalizeText(visualAnalysis.resumo_visual, 'Leitura visual concluída.'),
      visual_analysis_details: normalizeText(visualAnalysis.detalhamento_visual, 'Sem detalhamento visual adicional.'),
      visual_observations: normalizeArray(visualAnalysis.observacoes_visuais),
      transcription_notes: transcriptSummary,
      selected_mode: mode,
      selected_mode_label: selectedModeLabel,
      display_mode: 'complete',
      evaluations: {
        geral: {
          nota: overall.nota,
          status: overall.status,
          pontos_positivos: overall.pontos_positivos,
          pontos_negativos: overall.pontos_negativos,
          explicacao_ajustes: overall.explicacao_ajustes
        },
        comercial,
        institucional,
        prova_social: provaSocial
      }
    };
  }

  const modeMap = {
    comercial,
    institucional,
    prova_social: provaSocial
  };

  const selectedEvaluation = modeMap[mode] || comercial;

  const finalAnalysisText = buildSingleModeAnalysisText({
    mode,
    videoName,
    evaluation: selectedEvaluation,
    transcriptSummary,
    visualSummary: normalizeText(visualAnalysis.resumo_visual, 'Leitura visual concluída.'),
    visualDetails: normalizeText(visualAnalysis.detalhamento_visual, 'Sem detalhamento visual adicional.')
  });

  return {
    resultado: selectedEvaluation.status,
    score: selectedEvaluation.nota,
    summary,
    script_analysis: finalAnalysisText,
    instagram_caption: instagramCaption,
    transcript_full: transcriptText,
    positives: selectedEvaluation.pontos_positivos,
    negatives: selectedEvaluation.pontos_negativos,
    adjustments: [selectedEvaluation.explicacao_ajustes],
    visual_analysis_summary: normalizeText(visualAnalysis.resumo_visual, 'Leitura visual concluída.'),
    visual_analysis_details: normalizeText(visualAnalysis.detalhamento_visual, 'Sem detalhamento visual adicional.'),
    visual_observations: normalizeArray(visualAnalysis.observacoes_visuais),
    transcription_notes: transcriptSummary,
    selected_mode: mode,
    selected_mode_label: selectedModeLabel,
    display_mode: 'single',
    evaluations: {
      selected: {
        mode,
        label: selectedModeLabel,
        nota: selectedEvaluation.nota,
        status: selectedEvaluation.status,
        pontos_positivos: selectedEvaluation.pontos_positivos,
        pontos_negativos: selectedEvaluation.pontos_negativos,
        explicacao_ajustes: selectedEvaluation.explicacao_ajustes
      }
    }
  };
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

    const mode = String(req.body.mode || 'completo').trim().toLowerCase();
    const videoName = getVideoName(req.file);

    console.log('🎥 Processando vídeo:', {
      originalname: req.file.originalname,
      savedAs: req.file.filename,
      mimetype: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      mode
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
    // 1) TRANSCRIÇÃO MAIS PRECISA
    // ========================
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: 'gpt-4o-transcribe',
      language: 'pt',
      temperature: 0,
      prompt: [
        'Transcreva com máxima fidelidade em português do Brasil.',
        'Preserve números, preços, nomes, ofertas e chamadas para ação.',
        'Evite resumir, interpretar ou reescrever.',
        'Se houver trechos inaudíveis, mantenha a melhor aproximação possível sem inventar conteúdo.'
      ].join(' '),
      response_format: 'json'
    });

    const transcriptText = normalizeText(transcription?.text);

    if (!transcriptText) {
      return res.json({
        resultado: 'APROVADO COM AJUSTES',
        score: 61,
        summary: `O arquivo "${req.file.originalname}" foi enviado, mas a transcrição retornou vazia.`,
        script_analysis: [
          `🎬 VIDEO ${videoName}`,
          ``,
          `NOTA: 61`,
          `STATUS: APROVADO COM AJUSTES`,
          ``,
          `✅ PONTOS POSITIVOS`,
          `- O upload do vídeo foi concluído com sucesso.`,
          `- O arquivo foi recebido pelo sistema sem erro de envio.`,
          `- A estrutura de análise está operacional.`,
          `- O vídeo está disponível para nova tentativa de leitura.`,
          `- Há base técnica para reprocessar o material.`,
          ``,
          `❌ PONTOS QUE DEVEM MUDAR`,
          `- O áudio não gerou transcrição útil.`,
          `- Pode haver ruído, volume baixo ou fala pouco clara.`,
          `- O conteúdo falado pode estar insuficiente para avaliação textual.`,
          `- A precisão da leitura ficou comprometida.`,
          `- A análise final perde força sem o texto do áudio.`,
          ``,
          `🔧 EXPLICAÇÃO DOS AJUSTES`,
          `Sem transcrição consistente, a avaliação perde clareza comercial, institucional e de prova social. Corrija áudio, dicção, volume e captação para melhorar retenção, entendimento da oferta e qualidade da análise.`
        ].join('\n'),
        instagram_caption: 'Melhore captação, clareza da fala e força da mensagem para transformar o vídeo em uma peça mais convincente. Regrave e envie novamente para uma análise completa.',
        transcript_full: 'Sem transcrição detectada.',
        positives: [
          'Upload concluído com sucesso.',
          'O arquivo foi aceito pelo sistema.',
          'A rota de análise está operacional.',
          'O vídeo pode ser reprocessado.',
          'A estrutura da resposta foi mantida.'
        ],
        negatives: [
          'A IA não identificou fala suficiente para transcrever.',
          'O áudio pode estar baixo ou com ruído.',
          'A mensagem falada pode estar pouco clara.',
          'A análise textual ficou limitada.',
          'A precisão da transcrição ficou comprometida.'
        ],
        adjustments: [
          'Verifique se o vídeo possui áudio audível.',
          'Teste com fala mais clara e objetiva.',
          'Reduza ruído e trilha excessiva.',
          'Aproxime o microfone da fonte de voz.',
          'Reenvie o vídeo para nova análise.'
        ],
        visual_analysis_summary: 'Análise visual não executada porque a transcrição já retornou vazia e a resposta foi encerrada nesta etapa.',
        selected_mode: mode,
        selected_mode_label: getModeMeta(mode).label,
        display_mode: mode === 'completo' ? 'complete' : 'single',
        evaluations: {}
      });
    }

    // ========================
    // 2) ANÁLISE VISUAL POR FRAMES
    // ========================
    const { framePaths, visualNote } = await extractFramesFromVideo(req.file.path, req.file.originalname);
    const visualAnalysis = await analyzeVisualFrames(framePaths, videoName);

    // ========================
    // 3) PRIORIZAÇÃO PELO MODO ESCOLHIDO
    // ========================
    const modeConfig = {
      completo: {
        label: 'Completo',
        focusInstruction: `
Priorize uma visão integrada do criativo.
Considere vendas, marca e prova social ao mesmo tempo.
A nota geral deve refletir o equilíbrio total entre áudio, visual, persuasão e percepção.
`.trim(),
        summaryInstruction: `
Dê peso equilibrado para:
- capacidade de vender
- força de marca
- credibilidade/prova social
`.trim()
      },
      comercial: {
        label: 'Comercial (Vendas)',
        focusInstruction: `
A PRIORIDADE MÁXIMA desta análise é VENDAS.
Dê mais peso para:
- gancho inicial
- clareza da oferta
- geração de desejo
- argumentação
- persuasão
- CTA
Se marca ou prova social estiverem boas mas o poder de venda estiver fraco, a nota deve cair.
`.trim(),
        summaryInstruction: `
A nota geral deve refletir principalmente a capacidade real de gerar venda.
`.trim()
      },
      institucional: {
        label: 'Institucional (Marca)',
        focusInstruction: `
A PRIORIDADE MÁXIMA desta análise é MARCA.
Dê mais peso para:
- percepção de marca
- narrativa
- conexão emocional
- clareza da mensagem
- autoridade
- consistência visual
Se o vídeo vender bem, mas enfraquecer a percepção da marca, a nota deve cair.
`.trim(),
        summaryInstruction: `
A nota geral deve refletir principalmente autoridade, construção de marca e conexão.
`.trim()
      },
      prova_social: {
        label: 'Prova Social',
        focusInstruction: `
A PRIORIDADE MÁXIMA desta análise é PROVA SOCIAL.
Dê mais peso para:
- autenticidade
- credibilidade
- clareza do resultado
- identificação com o público
- validação real
Se o vídeo estiver bonito mas parecer pouco confiável ou sem prova forte, a nota deve cair.
`.trim(),
        summaryInstruction: `
A nota geral deve refletir principalmente confiança, validação e credibilidade percebida.
`.trim()
      }
    };

    const selectedModeConfig = modeConfig[mode] || modeConfig.completo;

    // ========================
    // 4) ANÁLISE ESTRATÉGICA COMPLETA
    // ========================
    const analysisPrompt = `
Você é um avaliador sênior de criativos em vídeo, marketing de performance, branding e prova social.

Sua tarefa é avaliar o vídeo usando:
1. a transcrição do áudio
2. a leitura visual dos frames do próprio vídeo

MODO SELECIONADO PELO USUÁRIO:
${selectedModeConfig.label}

ORIENTAÇÃO DE PRIORIDADE:
${selectedModeConfig.focusInstruction}

INSTRUÇÃO PARA NOTA GERAL:
${selectedModeConfig.summaryInstruction}

Teremos três avaliações diferentes:
- AVALIAÇÃO COMERCIAL (VENDAS)
- AVALIAÇÃO INSTITUCIONAL (MARCA)
- AVALIAÇÃO PROVA SOCIAL

Use EXATAMENTE esta escala:
0 a 60 → REPROVADO TOTAL
61 a 79 → APROVADO COM AJUSTES
80 a 100 → APROVADO

⚠️ A nota deve ser um número inteiro de 0 a 100.
⚠️ A resposta NUNCA pode ser apenas a nota.
⚠️ Toda avaliação deve conter obrigatoriamente:
- Nota
- Status
- Pontos de melhoria
- Pontos positivos
- Explicação detalhada dos ajustes

Responda APENAS em JSON válido.
Não use markdown.
Não use crases.
Não escreva texto fora do JSON.

Formato obrigatório:
{
  "geral": {
    "nota": 0,
    "status": "",
    "pontos_positivos": [],
    "pontos_negativos": [],
    "explicacao_ajustes": "",
    "resumo": ""
  },
  "avaliacao_comercial": {
    "nota": 0,
    "status": "",
    "pontos_positivos": [],
    "pontos_negativos": [],
    "explicacao_ajustes": ""
  },
  "avaliacao_institucional": {
    "nota": 0,
    "status": "",
    "pontos_positivos": [],
    "pontos_negativos": [],
    "explicacao_ajustes": ""
  },
  "avaliacao_prova_social": {
    "nota": 0,
    "status": "",
    "pontos_positivos": [],
    "pontos_negativos": [],
    "explicacao_ajustes": ""
  },
  "instagram_caption": "",
  "transcricao_observacoes": ""
}

REGRAS OBRIGATÓRIAS:
- pontos_positivos: mínimo 5 itens em cada bloco
- pontos_negativos: mínimo 5 itens em cada bloco
- explicacao_ajustes: prática, direta, estratégica e aplicável
- não seja genérico
- não suavize críticas
- nota acima de 80 só se o vídeo estiver realmente forte
- nota abaixo de 60 se houver falhas graves
- vídeos medianos devem cair em APROVADO COM AJUSTES

CRITÉRIOS:
🟠 AVALIAÇÃO COMERCIAL (VENDAS)
- gancho inicial
- clareza da oferta
- geração de desejo
- argumentação e persuasão
- CTA
Foco: capacidade de gerar venda

🔵 AVALIAÇÃO INSTITUCIONAL (MARCA)
- gancho
- storytelling
- conexão emocional
- clareza da mensagem
- construção de marca
Foco: autoridade, percepção e conexão

🟢 AVALIAÇÃO PROVA SOCIAL
- autenticidade
- clareza do resultado
- credibilidade
- identificação
- força da prova
Foco: confiança e validação real

IMPORTANTE:
- Baseie sua avaliação no áudio e no visual
- Se o visual enfraquecer a peça, isso deve afetar a nota
- Se o áudio for bom mas o visual for fraco, critique isso com firmeza
- Se houver incoerência entre fala e imagem, critique isso
- responda em português do Brasil

DADOS DO VÍDEO:
Nome do vídeo: ${videoName}

TRANSCRIÇÃO DO ÁUDIO:
${transcriptText}

ANÁLISE VISUAL RESUMIDA:
${visualAnalysis.resumo_visual}

OBSERVAÇÕES VISUAIS:
${(visualAnalysis.observacoes_visuais || []).map(item => `- ${item}`).join('\n')}

DETALHAMENTO VISUAL:
${visualAnalysis.detalhamento_visual}

NOTA TÉCNICA DE FRAMES:
${visualNote}
`.trim();

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: 'Você responde apenas com JSON válido, consistente e completo.'
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
        resultado: 'APROVADO COM AJUSTES',
        score: 61,
        summary: 'A transcrição e a leitura visual foram executadas, mas a resposta analítica não veio em JSON válido.',
        script_analysis: [
          `🎬 VIDEO ${videoName}`,
          ``,
          `NOTA: 61`,
          `STATUS: APROVADO COM AJUSTES`,
          ``,
          `✅ PONTOS POSITIVOS`,
          `- A transcrição foi concluída com sucesso.`,
          `- A leitura visual foi iniciada com base em frames do vídeo.`,
          `- O sistema recebeu material suficiente para análise.`,
          `- A estrutura principal da rota continua funcionando.`,
          `- O vídeo pode ser reprocessado sem alterar o restante do projeto.`,
          ``,
          `❌ PONTOS QUE DEVEM MUDAR`,
          `- A camada analítica não retornou JSON válido.`,
          `- A estrutura de saída da IA falhou.`,
          `- A consolidação final da avaliação ficou comprometida.`,
          `- A resposta não atendeu ao formato obrigatório.`,
          `- É necessário reforçar o controle de estrutura da saída.`,
          ``,
          `🔧 EXPLICAÇÃO DOS AJUSTES`,
          `O problema não está no upload nem na transcrição, mas na formatação final da camada de análise. Ajustar a resposta da IA é necessário para manter a entrega completa com nota, status, pontos positivos, pontos de melhoria e explicação aplicável.`
        ].join('\n'),
        instagram_caption: 'A mensagem do vídeo tem potencial, mas precisa de estrutura mais sólida para converter melhor. Ajuste clareza, prova e chamada para ação antes de escalar.',
        transcript_full: transcriptText,
        positives: [
          'Transcrição gerada com sucesso.',
          'Frames do vídeo foram considerados na avaliação.',
          'O upload foi processado corretamente.',
          'A rota manteve compatibilidade com o sistema atual.',
          'O vídeo pode ser reavaliado rapidamente.'
        ],
        negatives: [
          'Falha ao estruturar a análise da IA.',
          'A resposta não veio em JSON válido.',
          'A entrega final ficou incompleta.',
          'O formato obrigatório não foi respeitado.',
          'A consolidação automática foi interrompida.'
        ],
        adjustments: [
          'Tentar novamente a análise.',
          'Reforçar o prompt estrutural.',
          'Revalidar o JSON retornado.',
          'Manter os campos obrigatórios da resposta.',
          'Monitorar logs da camada analítica.'
        ],
        visual_analysis_summary: visualAnalysis.resumo_visual,
        selected_mode: mode,
        selected_mode_label: selectedModeConfig.label,
        display_mode: mode === 'completo' ? 'complete' : 'single',
        evaluations: {}
      });
    }

    const overall = normalizeEvaluationBlock(aiData.geral, 'geral');
    const comercial = normalizeEvaluationBlock(aiData.avaliacao_comercial, 'comercial');
    const institucional = normalizeEvaluationBlock(aiData.avaliacao_institucional, 'institucional');
    const provaSocial = normalizeEvaluationBlock(aiData.avaliacao_prova_social, 'prova_social');

    const overallScore = overall.nota;
    const overallStatus = normalizeStatus(aiData?.geral?.status, overallScore);

    const selectedSummaries = {
      completo: normalizeText(
        aiData?.geral?.resumo,
        `Avaliação concluída com base na transcrição do áudio e na leitura visual dos frames do vídeo, priorizando o modo ${selectedModeConfig.label}.`
      ),
      comercial: normalizeText(
        aiData?.avaliacao_comercial?.explicacao_ajustes,
        'Avaliação comercial concluída com foco em venda, oferta, persuasão e CTA.'
      ),
      institucional: normalizeText(
        aiData?.avaliacao_institucional?.explicacao_ajustes,
        'Avaliação institucional concluída com foco em marca, autoridade e percepção.'
      ),
      prova_social: normalizeText(
        aiData?.avaliacao_prova_social?.explicacao_ajustes,
        'Avaliação de prova social concluída com foco em credibilidade, confiança e validação.'
      )
    };

    const transcriptSummary = normalizeText(
      aiData?.transcricao_observacoes,
      'A transcrição foi realizada com foco em fidelidade do áudio para sustentar a avaliação estratégica.'
    );

    return res.json(buildResponsePayload({
      mode,
      videoName,
      summary: selectedSummaries[mode] || selectedSummaries.completo,
      transcriptText,
      transcriptSummary,
      visualAnalysis,
      selectedModeLabel: selectedModeConfig.label,
      overall: {
        nota: overallScore,
        status: overallStatus,
        pontos_positivos: overall.pontos_positivos,
        pontos_negativos: overall.pontos_negativos,
        explicacao_ajustes: overall.explicacao_ajustes
      },
      comercial,
      institucional,
      provaSocial,
      instagramCaption: normalizeText(
        aiData.instagram_caption,
        'Sua comunicação pode vender mais com gancho mais forte, oferta mais clara e prova mais convincente. Ajuste a estrutura do vídeo e chame para ação com mais firmeza.'
      )
    }));
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
