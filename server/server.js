const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const natural = require('natural');
const Sentiment = require('sentiment');
require('dotenv').config();

// Initialize Express app
const app = express();
app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));
app.use(express.json());

// Create HTTP server and Socket.io instance
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// MongoDB User Model
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

const User = mongoose.model('User', userSchema);

// Train AI chatbot
const classifier = new natural.BayesClassifier();
classifier.addDocument('hello', 'greeting');
classifier.addDocument('hi', 'greeting');
classifier.addDocument('hey', 'greeting');
classifier.addDocument('how are you?', 'greeting');
classifier.addDocument('bye', 'farewell');
classifier.addDocument('goodbye', 'farewell');
classifier.addDocument('thanks', 'gratitude');
classifier.addDocument('thank you', 'gratitude');
classifier.addDocument('help', 'help');
classifier.train();

// Sentiment analysis
const sentiment = new Sentiment();

// Smart replies
const smartReplies = {
  'hello': ['Hi there!', 'Hello!', 'Hey!'],
  'how are you?': ['I’m good, thanks!', 'Doing well!', 'All good here!'],
  'thanks': ['You’re welcome!', 'No problem!', 'Anytime!'],
  'help': ['How can I help?', 'What do you need help with?', 'I’m here to help!']
};

// Auth Middleware
const authMiddleware = (req, res, next) => {
  const token = req.header('x-auth-token');
  if (!token) return res.status(401).json({ message: 'No token, authorization denied' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded.userId;
    next();
  } catch (err) {
    res.status(400).json({ message: 'Token is not valid' });
  }
};

// Auth Routes
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ message: 'User already exists' });

    user = new User({ name, email, password });
    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.status(201).json({ token, userId: user._id });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, userId: user._id });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Protected route example
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// Socket.io Connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Join a room (user ID) for private messages
  socket.on('joinRoom', (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined room: ${userId}`);
  });

  // Handle sending messages
  socket.on('sendMessage', ({ text, to }) => {
    console.log(`Message from ${socket.id} to ${to}: ${text}`);

    const message = {
      text,
      from: socket.id,
      timestamp: new Date()
    };

    if (to && to !== 'AI') {
      // Private message: send to specific user's room
      io.to(to).emit('receiveMessage', message);
      // Also send to sender
      io.to(socket.id).emit('receiveMessage', message);
    } else {
      // AI response or broadcast
      const intent = classifier.classify(text);
      let aiResponse = '';

      if (intent === 'greeting') {
        aiResponse = 'Hello! How can I help you today?';
      } else if (intent === 'farewell') {
        aiResponse = 'Goodbye! Have a great day!';
      } else if (intent === 'gratitude') {
        aiResponse = 'You\'re welcome! 😊';
      } else if (intent === 'help') {
        aiResponse = 'I can help with general questions. What do you need?';
      } else {
        aiResponse = 'I didn\'t understand that. Can you rephrase?';
      }

      // Send AI response back to the user
      io.to(socket.id).emit('receiveMessage', {
        text: aiResponse,
        from: 'AI',
        timestamp: new Date()
      });
    }

    // Sentiment Analysis
    const result = sentiment.analyze(text);
    io.to(socket.id).emit('messageSentiment', { text, score: result.score });

    // Smart Replies
    const replyOptions = smartReplies[text.toLowerCase()];
    if (replyOptions) {
      io.to(socket.id).emit('smartReplies', replyOptions);
    }
  });

  // Typing indicator
  socket.on('typing', (data) => {
    socket.broadcast.to(data.to).emit('typing', { from: socket.id });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start Server
const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
