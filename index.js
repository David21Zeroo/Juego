Const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const httpServer = createServer(app);

// Servir archivos estáticos
app.use(express.static(path.join(__dirname)));

// CORS para permitir conexiones desde el frontend
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Almacenamiento de salas en memoria
const rooms = new Map();

// Generar código de sala aleatorio (6 caracteres)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Endpoints REST
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size });
});

// Crear nueva sala
app.post('/create-room', (req, res) => {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  const room = {
    code,
    players: [],
    gameState: null,
    createdAt: Date.now()
  };

  rooms.set(code, room);
  console.log(`Sala creada: ${code}`);
  
  res.json({ code, success: true });
});

// Verificar si sala existe
app.get('/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) {
    return res.status(404).json({ error: 'Sala no encontrada' });
  }
  
  res.json({
    code: room.code,
    playerCount: room.players.length,
    isFull: room.players.length >= 2
  });
});

// WebSocket handlers
io.on('connection', (socket) => {
  console.log('Nuevo cliente conectado:', socket.id);

  // Unirse a una sala
  socket.on('join-room', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error', { message: 'Sala no encontrada' });
      return;
    }

    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Sala llena' });
      return;
    }

    // Unir al socket a la sala
    socket.join(code);
    
    // Agregar jugador
    const player = {
      id: room.players.length + 1,
      socketId: socket.id,
      name: playerName,
      score: 0
    };
    room.players.push(player);
    socket.roomCode = code;
    socket.playerId = player.id;

    console.log(`${playerName} se unió a la sala ${code}`);

    // Notificar al jugador que se unió
    socket.emit('joined-room', {
      roomCode: code,
      playerId: player.id,
      playerName: player.name
    });

    // Notificar a todos en la sala sobre el nuevo jugador
    io.to(code).emit('player-joined', {
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
      playerCount: room.players.length
    });

    // Si hay 2 jugadores, iniciar el juego
    if (room.players.length === 2) {
      room.gameState = {
        currentPlayer: 1,
        round: 1,
        usedQuestions: [],
        currentQuestion: null
      };
      
      io.to(code).emit('game-start', {
        players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
        gameState: room.gameState
      });
    }
  });

  // Crear sala desde socket
  socket.on('create-room', ({ playerName }) => {
    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    const room = {
      code,
      players: [],
      gameState: null,
      createdAt: Date.now()
    };

    rooms.set(code, room);
    console.log(`Sala creada por socket: ${code}`);

    // Unir al creador
    socket.join(code);
    
    const player = {
      id: 1,
      socketId: socket.id,
      name: playerName,
      score: 0
    };
    room.players.push(player);
    socket.roomCode = code;
    socket.playerId = player.id;

    socket.emit('room-created', {
      roomCode: code,
      playerId: player.id,
      playerName: player.name
    });

    socket.emit('player-joined', {
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
      playerCount: room.players.length
    });
  });

  // Seleccionar modo (verdad o reto)
  socket.on('select-mode', ({ mode }) => {
    const code = socket.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room || !room.gameState) return;

    // Generar pregunta aleatoria
    const questions = getQuestionsByMode(mode);
    const available = questions.filter(q => !room.gameState.usedQuestions.includes(q.id));
    
    let question;
    if (available.length === 0) {
      room.gameState.usedQuestions = [];
      question = questions[Math.floor(Math.random() * questions.length)];
    } else {
      question = available[Math.floor(Math.random() * available.length)];
    }

    room.gameState.currentQuestion = question;
    room.gameState.usedQuestions.push(question.id);

    io.to(code).emit('question-selected', {
      question,
      gameState: room.gameState
    });
  });

  // Completar desafío
  socket.on('complete-challenge', ({ completed }) => {
    const code = socket.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room || !room.gameState) return;

    const currentPlayer = room.players.find(p => p.id === room.gameState.currentPlayer);
    if (currentPlayer && completed) {
      currentPlayer.score += 10;
    }

    // Cambiar turno
    room.gameState.currentPlayer = room.gameState.currentPlayer === 1 ? 2 : 1;
    if (room.gameState.currentPlayer === 1) {
      room.gameState.round += 1;
    }
    room.gameState.currentQuestion = null;

    io.to(code).emit('challenge-completed', {
      completed,
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
      gameState: room.gameState
    });
  });

  // Saltar pregunta
  socket.on('skip-question', () => {
    const code = socket.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room || !room.gameState) return;

    room.gameState.currentQuestion = null;

    io.to(code).emit('question-skipped', {
      gameState: room.gameState
    });
  });

  // Terminar juego
  socket.on('end-game', () => {
    const code = socket.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    io.to(code).emit('game-ended', {
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score }))
    });
  });

  // Reiniciar juego
  socket.on('reset-game', () => {
    const code = socket.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    room.players.forEach(p => p.score = 0);
    room.gameState = {
      currentPlayer: 1,
      round: 1,
      usedQuestions: [],
      currentQuestion: null
    };

    io.to(code).emit('game-reset', {
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
      gameState: room.gameState
    });
  });

  // Desconexión
  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    
    const code = socket.roomCode;
    if (code) {
      const room = rooms.get(code);
      if (room) {
        room.players = room.players.filter(p => p.socketId !== socket.id);
        
        if (room.players.length === 0) {
          rooms.delete(code);
          console.log(`Sala eliminada: ${code}`);
        } else {
          io.to(code).emit('player-left', {
            players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
            playerCount: room.players.length
          });
        }
      }
    }
  });
});

// Banco de preguntas
function getQuestionsByMode(mode) {
  const questions = [
    // VERDADES - Fáciles
    { id: 1, type: 'truth', text: '¿Cuál es tu comida favorita?', level: 'easy' },
    { id: 2, type: 'truth', text: '¿Cuál es tu película favorita de todos los tiempos?', level: 'easy' },
    { id: 3, type: 'truth', text: '¿Qué lugar del mundo te gustaría visitar?', level: 'easy' },
    { id: 4, type: 'truth', text: '¿Cuál es tu hobby favorito?', level: 'easy' },
    { id: 5, type: 'truth', text: '¿Prefieres el mar o la montaña?', level: 'easy' },
    { id: 6, type: 'truth', text: '¿Cuál es tu canción favorita actualmente?', level: 'easy' },
    { id: 7, type: 'truth', text: '¿Tienes alguna fobia?', level: 'easy' },
    { id: 8, type: 'truth', text: '¿Qué superpoder te gustaría tener?', level: 'easy' },
    
    // VERDADES - Medias
    { id: 9, type: 'truth', text: '¿Cuál ha sido tu peor cita?', level: 'medium' },
    { id: 10, type: 'truth', text: '¿Alguna vez has mentido para no herir los sentimientos de alguien?', level: 'medium' },
    { id: 11, type: 'truth', text: '¿Cuál es tu mayor arrepentimiento?', level: 'medium' },
    { id: 12, type: 'truth', text: '¿Has tenido un crush con el/la ex de un amigo/a?', level: 'medium' },
    { id: 13, type: 'truth', text: '¿Cuál es tu secreto más vergonzoso?', level: 'medium' },
    { id: 14, type: 'truth', text: '¿Alguna vez has espiado las redes sociales de alguien?', level: 'medium' },
    { id: 15, type: 'truth', text: '¿Cuál es la mentira más grande que has contado?', level: 'medium' },
    { id: 16, type: 'truth', text: '¿Alguna vez has fingido no recibir un mensaje?', level: 'medium' },
    
    // VERDADES - Picantes
    { id: 17, type: 'truth', text: '¿Cuál es tu fantasía más atrevida?', level: 'hot' },
    { id: 18, type: 'truth', text: '¿Cuál es el lugar más inesperado donde has tenido un encuentro íntimo?', level: 'hot' },
    { id: 19, type: 'truth', text: '¿Alguna vez has tenido un sueño erótico con alguien de esta sala?', level: 'hot' },
    { id: 20, type: 'truth', text: '¿Cuál es tu posición favorita?', level: 'hot' },
    { id: 21, type: 'truth', text: '¿Alguna vez has enviado fotos atrevidas?', level: 'hot' },
    { id: 22, type: 'truth', text: '¿Cuál es tu zona erógena favorita?', level: 'hot' },
    
    // RETOS - Fáciles
    { id: 23, type: 'dare', text: 'Haz 10 sentadillas', level: 'easy' },
    { id: 24, type: 'dare', text: 'Canta tu canción favorita durante 30 segundos', level: 'easy' },
    { id: 25, type: 'dare', text: 'Haz una imitación de un animal', level: 'easy' },
    { id: 26, type: 'dare', text: 'Baila sin música durante 20 segundos', level: 'easy' },
    { id: 27, type: 'dare', text: 'Dile "te amo" a la última persona con la que chateaste', level: 'easy' },
    { id: 28, type: 'dare', text: 'Habla con acento extranjero durante 2 minutos', level: 'easy' },
    { id: 29, type: 'dare', text: 'Haz 5 burpees', level: 'easy' },
    { id: 30, type: 'dare', text: 'Publica una historia en redes con una cara graciosa', level: 'easy' },
    
    // RETOS - Medios
    { id: 31, type: 'dare', text: 'Llama a alguien y canta "Cumpleaños Feliz"', level: 'medium' },
    { id: 32, type: 'dare', text: 'Envía un mensaje de voz cantando a tu crush o ex', level: 'medium' },
    { id: 33, type: 'dare', text: 'Haz una confesión falsa en redes sociales', level: 'medium' },
    { id: 34, type: 'dare', text: 'Dale like a las 10 primeras publicaciones de tu ex', level: 'medium' },
    { id: 35, type: 'dare', text: 'Haz un striptease (quedándote en ropa interior)', level: 'medium' },
    { id: 36, type: 'dare', text: 'Llama a un número aleatorio y pregunta si venden pizza', level: 'medium' },
    { id: 37, type: 'dare', text: 'Envía un mensaje picante a la última persona que te escribió', level: 'medium' },
    
    // RETOS - Picantes
    { id: 38, type: 'dare', text: 'Dale un beso apasionado al otro jugador', level: 'hot' },
    { id: 39, type: 'dare', text: 'Haz un lap dance al otro jugador', level: 'hot' },
    { id: 40, type: 'dare', text: 'Quédate en ropa interior por el resto del juego', level: 'hot' },
    { id: 41, type: 'dare', text: 'Deja que el otro jugador te haga un masaje por 2 minutos', level: 'hot' },
    { id: 42, type: 'dare', text: 'Intercambia una prenda de ropa con el otro jugador', level: 'hot' },
    { id: 43, type: 'dare', text: 'Hazle un cumplido muy atrevido al otro jugador', level: 'hot' },
  ];

  return questions.filter(q => q.type === mode);
}

// Limpiar salas antiguas cada 30 minutos
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > 30 * 60 * 1000) { // 30 minutos
      rooms.delete(code);
      console.log(`Sala expirada eliminada: ${code}`);
    }
  }
}, 5 * 60 * 1000); // Cada 5 minutos

const PORT = process.env.PORT || 3001;

httpServer.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
