const express = require('express');
const mongoose = require('mongoose');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
const connectWithRetry = async () => {
  const options = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    family: 4,
    ssl: true,
    tls: true,
    retryWrites: true,
    w: 'majority'
  };

  try {
    const uri = process.env.MONGODB_URI;
    console.log('Raw MONGODB_URI:', uri); // Add this line to see the raw URI
    
    if (!uri) {
      throw new Error('MONGODB_URI is not set in environment variables');
    }
    
    if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
      throw new Error(`Invalid MongoDB URI format: ${uri}`);
    }
    
    console.log('Attempting to connect to MongoDB...');
    console.log('Connection URI:', uri.replace(/\/\/[^:]+:[^@]+@/, '//<credentials>@')); // Hide credentials in logs
    
    await mongoose.connect(uri, options);
    console.log('Connected to MongoDB successfully');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    console.log('Connection details:', {
      uri: process.env.MONGODB_URI ? 'URI is set' : 'URI is not set',
      options: JSON.stringify(options, null, 2)
    });
    console.log('Retrying connection in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};

connectWithRetry();

// Handle MongoDB connection events
mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected. Attempting to reconnect...');
  connectWithRetry();
});

mongoose.connection.on('connected', () => {
  console.log('MongoDB connected successfully');
});

// User Schema
const userSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  chatId: { type: String, required: true },
  username: { type: String, required: true },
  creditScore: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Create a compound unique index
userSchema.index({ telegramId: 1, chatId: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);

// Drop existing indexes and recreate them
User.collection.dropIndexes().then(() => {
  console.log('Dropped existing indexes');
  User.collection.createIndex({ telegramId: 1, chatId: 1 }, { unique: true });
  console.log('Created new compound index');
}).catch(err => {
  console.error('Error managing indexes:', err);
});

// Sticker credit values
const STICKER_CREDITS = {
  'CAACAgQAAyEFAASg28saAAMGaB32UymgiQTGbVE0BpSniAqLg-kAAnYZAAKd5PFQFEAlUp3q1aM2BA': 20,  // Add 20 points
  'CAACAgQAAyEFAASg28saAAMLaB33YRqT3aY0WJq1j3JujLr_MokAAmwYAALVfPFQvaBMA18SdHI2BA': -20  // Subtract 20 points
};

// Telegram Bot setup
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10,
      allowed_updates: ['message', 'callback_query', 'message_reaction'],
      offset: -1 // Start from the latest update
    }
  }
});

// Handle polling errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
  
  // If it's a conflict error, try to restart polling with a delay
  if (error.code === 'ETELEGRAM' && error.message.includes('409 Conflict')) {
    console.log('Polling conflict detected. Restarting polling in 5 seconds...');
    
    // Stop polling
    bot.stopPolling().then(() => {
      // Wait 5 seconds before restarting
      setTimeout(() => {
        console.log('Restarting polling...');
        bot.startPolling({
          interval: 300,
          autoStart: true,
          params: {
            timeout: 10,
            allowed_updates: ['message', 'callback_query', 'message_reaction'],
            offset: -1 // Start from the latest update
          }
        }).catch(err => {
          console.error('Error restarting polling:', err);
        });
      }, 5000);
    }).catch(err => {
      console.error('Error stopping polling:', err);
    });
  }
});

// Set up bot commands
bot.setMyCommands([
  { command: '/start', description: 'Start using the bot and register in the current group' },
  { command: '/score', description: 'Check your current credit score in this group' },
  { command: '/leaderboard', description: 'View the top 10 credit scores in this group' }
]).catch(error => {
  console.error('Error setting bot commands:', error);
});

// Handle /start command
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.first_name || msg.from.username;

    // Check if user already exists
    let user = await User.findOne({ 
      telegramId: userId.toString(),
      chatId: chatId.toString()
    });

    if (!user) {
      // Create new user
      user = new User({
        telegramId: userId.toString(),
        chatId: chatId.toString(),
        username: username,
        creditScore: 0
      });
      await user.save();
      await bot.sendMessage(chatId, `👋 Welcome ${username}! You've been registered in the Fuel Credit Score system. Your initial score is 0.`);
    } else {
      await bot.sendMessage(chatId, `👋 Hey fren ${username}! Your current credit score is ${user.creditScore}.`);
    }
  } catch (err) {
    console.error('Error handling /start command:', err);
    await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error processing your request. Please try again later.");
  }
});

// Handle /leaderboard command
bot.onText(/\/leaderboard/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    
    // Get top 10 users for this chat
    const topUsers = await User.find({ chatId: chatId.toString() })
      .sort({ creditScore: -1 })
      .limit(10);

    if (topUsers.length === 0) {
      await bot.sendMessage(chatId, "📊 No credit scores recorded yet in this group.");
      return;
    }

    // Create leaderboard message
    let leaderboardMessage = "🏆 *Fuel Credit Score Leaderboard* 🏆\n\n";
    topUsers.forEach((user, index) => {
      const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
      leaderboardMessage += `${medal} ${user.username}: ${user.creditScore} points\n`;
    });

    await bot.sendMessage(chatId, leaderboardMessage, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error handling /leaderboard command:', err);
    await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error fetching the leaderboard. Please try again later.");
  }
});

// Handle /score command
bot.onText(/\/score/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    console.log('Score command received:', {
      chatId,
      userId,
      username: msg.from.username || msg.from.first_name
    });

    // Find user's score
    const user = await User.findOne({ 
      telegramId: userId.toString(),
      chatId: chatId.toString()
    });

    console.log('User lookup result:', user);

    if (!user) {
      await bot.sendMessage(chatId, "❌ You haven't registered yet. Use /start to register!");
      return;
    }

    const emoji = getScoreEmoji(user.creditScore);
    await bot.sendMessage(chatId, `${emoji} Your current credit score is: ${user.creditScore} points`);
  } catch (err) {
    console.error('Error handling /score command:', err);
    console.error('Error details:', {
      message: err.message,
      stack: err.stack,
      name: err.name
    });
    await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error fetching your score. Please try again later.");
  }
});

// Debug: Log all messages
bot.on('message', (msg) => {
  console.log('Received message:', JSON.stringify(msg, null, 2));
});

// Handle sticker reactions
bot.on('message_reaction', async (msg) => {
  try {
    // Get the message that was reacted to
    const message = await bot.getChat(msg.chat.id).then(chat => 
      bot.getChatHistory(chat.id, { limit: 1, offset: -1 })
    ).then(history => history[0]);

    if (!message) {
      console.log('No message found for reaction');
      return;
    }

    const messageAuthorId = message.from.id.toString();
    const messageAuthor = message.from;
    const reactorId = msg.from.id.toString();
    const chatId = msg.chat.id;

    // Debug logs
    console.log('Reaction details:', {
      messageAuthorId,
      reactorId,
      chatId,
      isBot: messageAuthor.is_bot,
      reaction: msg.reaction
    });

    // Prevent self-voting
    if (reactorId === messageAuthorId) {
      await bot.sendMessage(chatId, "❌ You can't change your own score!");
      return;
    }

    // Prevent bot scoring
    if (messageAuthor.is_bot) {
      await bot.sendMessage(chatId, "❌ Bots can't receive credit scores!");
      return;
    }

    // Find or create user
    let user = await User.findOne({ 
      telegramId: messageAuthorId,
      chatId: chatId.toString()
    });

    if (!user) {
      user = new User({
        telegramId: messageAuthorId,
        chatId: chatId.toString(),
        username: messageAuthor.first_name || messageAuthor.username,
        creditScore: 0
      });
    }

    // Update score based on reaction
    const oldScore = user.creditScore;
    if (msg.reaction[0].emoji === '👍') {
      user.creditScore += 20;
    } else if (msg.reaction[0].emoji === '👎') {
      user.creditScore -= 20;
    }

    await user.save();

    // Send confirmation message
    const emoji = getScoreEmoji(user.creditScore);
    await bot.sendMessage(
      chatId,
      `${emoji} ${user.username}'s credit score changed from ${oldScore} to ${user.creditScore}`
    );
  } catch (err) {
    console.error('Error handling reaction:', err);
    await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error processing your reaction. Please try again later.");
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
