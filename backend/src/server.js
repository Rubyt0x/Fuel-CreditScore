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
    console.log('Raw MONGODB_URI:', uri);
    
    if (!uri) {
      throw new Error('MONGODB_URI is not set in environment variables');
    }
    
    if (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://')) {
      throw new Error(`Invalid MongoDB URI format: ${uri}`);
    }
    
    console.log('Attempting to connect to MongoDB...');
    console.log('Connection URI:', uri.replace(/\/\/[^:]+:[^@]+@/, '//<credentials>@'));
    
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

// Initial connection
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

// Function to get or create collection for a specific chat
const getChatCollection = (chatId) => {
  return mongoose.model(`Users_${chatId}`, userSchema);
};

// Sticker credit values
const STICKER_CREDITS = {
  'CAACAgQAAxkBAAMJaC70UAGyYccTdJN7kWwcqpgD7ScAAnYZAAKd5PFQFEAlUp3q1aM2BA': 20,  // Add 20 points (👍)
  'CAACAgQAAxkBAAMYaC71bUrHYlMTtCvKe7AJUTvccqsAAmwYAALVfPFQvaBMA18SdHI2BA': -20,  // Subtract 20 points (👎)
  'CAACAgQAAyEFAASNsb1cAAEB1DxoR1ywgXya5nIdzlKZWFIuWMkFbgACdhkAAp3k8VAUQCVSnerVozYE': 20, // Add 20 points (👍 new)
  'CAACAgQAAyEFAASNsb1cAAEB065oR0CEpiUng5nVfWQnyAb6230kngACbBgAAtV88VC9oEwDXxJ0cjYE': -20, // Subtract 20 points (👎 new)
  'CAACAgQAAx0Cfqd5yAACmadoZlIcP3qkSXPuqLgRPgnOPmS8KQACdhkAAp3k8VAUQCVSnerVozYE': 20, // Add 20 points (👍 Rubyt0)
  'CAACAgQAAxkBAAPSaGZViuWooIVcSeWRsZT5MirCHOwAAmwYAALVfPFQvaBMA18SdHI2BA': -20, // Subtract 20 points (👎 Rubyt0)
  'CAACAgQAAx0Cfqd5yAACnVBog4HxT6GUSIpDDHvx0ate89LoZQACdhkAAp3k8VAUQCVSnerVozYE': 20, // Add 20 points (👍 new2)
  'CAACAgQAAxkBAAPkaIaD-2u-9SBu4q2HhwjGVjuuc58AAmwYAALVfPFQvaBMA18SdHI2BA': -20 // Subtract 20 points (👎 new2)
};

// Telegram Bot setup
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
  polling: {
    interval: 300,
    autoStart: false,
    params: {
      timeout: 10
    }
  }
});

let isPolling = false;
let retryCount = 0;
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;

// Start polling with error handling
const startPolling = async () => {
  if (isPolling) {
    console.log('Polling already in progress, skipping...');
    return;
  }

  try {
    isPolling = true;
    await bot.stopPolling();
    await bot.startPolling();
    console.log('Bot polling started successfully');
    retryCount = 0; // Reset retry count on successful start
  } catch (err) {
    console.error('Error starting bot polling:', err);
    isPolling = false;
    
    if (err.message.includes('terminated by other getUpdates request')) {
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`Retry attempt ${retryCount}/${MAX_RETRIES}. Waiting ${RETRY_DELAY/1000} seconds...`);
        setTimeout(startPolling, RETRY_DELAY);
      } else {
        console.error('Max retries reached. Please check if another instance is running.');
        process.exit(1);
      }
    }
  }
};

// Handle process termination
process.on('SIGINT', async () => {
  console.log('Stopping bot polling...');
  isPolling = false;
  await bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Stopping bot polling...');
  isPolling = false;
  await bot.stopPolling();
  process.exit(0);
});

// Start the bot
startPolling();

// Set up bot commands
bot.setMyCommands([
  { command: '/start', description: 'Start using the bot and register in the current group' },
  { command: '/score', description: 'Check your current credit score in this group' },
  { command: '/leaderboard', description: 'View the top 10 credit scores in this group' }
]).catch(error => {
  console.error('Error setting bot commands:', error);
});

// Debug: Log all messages
bot.on('message', (msg) => {
  console.log('Received message:', {
    type: msg.type,
    chat: {
      id: msg.chat.id,
      type: msg.chat.type,
      title: msg.chat.title
    },
    from: {
      id: msg.from.id,
      username: msg.from.username,
      first_name: msg.from.first_name
    },
    text: msg.text,
    sticker: msg.sticker ? {
      file_id: msg.sticker.file_id,
      emoji: msg.sticker.emoji,
      set_name: msg.sticker.set_name
    } : null
  });

  // Log if it's a command
  if (msg.text && msg.text.startsWith('/')) {
    console.log('Command received:', msg.text);
  }
});

// Handle /start command with more logging
bot.onText(/\/start/, async (msg) => {
  console.log('Start command handler triggered');
  try {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.first_name || msg.from.username;

    console.log('Processing start command:', {
      chatId,
      userId,
      username
    });

    // Get chat-specific collection
    const ChatUsers = getChatCollection(chatId.toString());

    // Check if user already exists
    let user = await ChatUsers.findOne({ 
      telegramId: userId.toString(),
      chatId: chatId.toString()
    });

    console.log('User lookup result:', user);

    if (!user) {
      // Create new user
      user = new ChatUsers({
        telegramId: userId.toString(),
        chatId: chatId.toString(),
        username: username,
        creditScore: 0
      });
      await user.save();
      console.log('New user created:', user);
      await bot.sendMessage(chatId, `👋 Welcome ${username}! You've been registered in the Fuel Credit Score system. Your initial score is 0.`);
    } else {
      console.log('Existing user found:', user);
      await bot.sendMessage(chatId, `👋 Hey fren ${username}! Your current credit score is ${user.creditScore}.`);
    }
  } catch (err) {
    console.error('Error handling /start command:', err);
    console.error('Error details:', {
      message: err.message,
      stack: err.stack,
      name: err.name
    });
    await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error processing your request. Please try again later.");
  }
});

// Handle /leaderboard command
bot.onText(/\/leaderboard/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    
    // Get chat-specific collection
    const ChatUsers = getChatCollection(chatId.toString());
    
    // Get top 10 users for this chat
    const topUsers = await ChatUsers.find({ chatId: chatId.toString() })
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

    // Get chat-specific collection
    const ChatUsers = getChatCollection(chatId.toString());

    // Find user's score
    const user = await ChatUsers.findOne({ 
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

// Debug: Log sticker information with more detail
bot.on('sticker', (msg) => {
  console.log('Sticker received:', {
    chat: {
      id: msg.chat.id,
      type: msg.chat.type,
      title: msg.chat.title
    },
    from: {
      id: msg.from.id,
      username: msg.from.username,
      first_name: msg.from.first_name
    },
    sticker: {
      file_id: msg.sticker.file_id,
      emoji: msg.sticker.emoji,
      set_name: msg.sticker.set_name,
      is_animated: msg.sticker.is_animated,
      is_video: msg.sticker.is_video,
      width: msg.sticker.width,
      height: msg.sticker.height,
      file_size: msg.sticker.file_size
    }
  });
});

// Helper function to get emoji based on score
const getScoreEmoji = (score) => {
  if (score > 100) return '🏅';  // Champion
  if (score > 50) return '🥇';   // Gold
  if (score > 0) return '🎯';    // Target
  if (score < -50) return '⚠️';  // Warning
  return '😅';                   // Struggling
};

// Helper function to get fun comment based on score and position
const getFunComment = (score, position) => {
  if (position === 1) {
    return "The most trusted citizen in the group!";
  } else if (position === 2) {
    return "Almost worthy of the highest privileges!";
  } else if (position === 3) {
    return "Still considered a model citizen!";
  } else if (score > 100) {
    return "Your loyalty to the group is unquestionable!";
  } else if (score > 50) {
    return "Your social standing is quite respectable!";
  } else if (score > 0) {
    return "Your behavior is... acceptable.";
  } else if (score > -50) {
    return "Your social credit needs improvement...";
  } else {
    return "Your behavior is being closely monitored!";
  }
};

// Handle sticker messages
bot.on('sticker', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const stickerId = msg.sticker.file_id;
    console.log('[Sticker Handler] Received sticker:', stickerId);

    // Check if this is a credit score sticker first
    if (!STICKER_CREDITS[stickerId]) {
      console.log('[Sticker Handler] Sticker not in STICKER_CREDITS, ignoring.');
      return;
    }
    console.log('[Sticker Handler] Sticker is in STICKER_CREDITS.');

    // Check if this is a reply to another message
    if (!msg.reply_to_message) {
      console.log('[Sticker Handler] Not a reply, sending warning.');
      await bot.sendMessage(chatId, "❌ Please reply to someone's message with the sticker to change their score!");
      return;
    }
    console.log('[Sticker Handler] Is a reply.');

    const targetUserId = msg.reply_to_message.from.id.toString();
    const targetUsername = msg.reply_to_message.from.first_name.split('|')[0].trim() || msg.reply_to_message.from.username;
    const senderId = msg.from.id.toString();

    // Prevent votes from user ID 777000
    if (senderId === '777000') {
      console.log('[Sticker Handler] Vote from user 777000 ignored');
      return;
    }
    console.log('[Sticker Handler] Sender is not 777000.');

    // Prevent self-voting
    if (senderId === targetUserId) {
      console.log('[Sticker Handler] Self-vote detected, sending warning.');
      await bot.sendMessage(chatId, "❌ You can't change your own score!");
      return;
    }
    console.log('[Sticker Handler] Not a self-vote.');

    // Prevent bot scoring
    if (msg.reply_to_message.from.is_bot) {
      console.log('[Sticker Handler] Target is a bot, sending warning.');
      await bot.sendMessage(chatId, "❌ Bots can't receive credit scores!");
      return;
    }
    console.log('[Sticker Handler] Target is not a bot.');

    // Get chat-specific collection
    const ChatUsers = getChatCollection(chatId.toString());

    // Find the user to update
    let user = await ChatUsers.findOne({ 
      telegramId: targetUserId,
      chatId: chatId.toString()
    });
    console.log('[Sticker Handler] User lookup result:', user);

    if (!user) {
      user = new ChatUsers({
        telegramId: targetUserId,
        chatId: chatId.toString(),
        username: targetUsername,
        creditScore: 0
      });
      console.log('[Sticker Handler] Created new user:', user);
    }

    // Update score
    const oldScore = user.creditScore;
    user.creditScore += STICKER_CREDITS[stickerId];
    await user.save();
    console.log('[Sticker Handler] Updated user score:', { oldScore, newScore: user.creditScore });

    // Get user's new position
    const position = await ChatUsers.countDocuments({
      chatId: chatId.toString(),
      creditScore: { $gt: user.creditScore }
    }) + 1;
    console.log('[Sticker Handler] User position:', position);

    // Get fun comment
    const comment = getFunComment(user.creditScore, position);
    console.log('[Sticker Handler] Fun comment:', comment);

    // Send confirmation message
    const emoji = getScoreEmoji(user.creditScore);
    console.log('[Sticker Handler] About to send confirmation message', { oldScore, newScore: user.creditScore, targetUsername });
    await bot.sendMessage(
      chatId,
      `${emoji} ${targetUsername}'s credit score changed from ${oldScore} to ${user.creditScore}\n${comment}`
    );
    console.log('[Sticker Handler] Confirmation message sent.');
  } catch (err) {
    console.error('Error handling sticker:', err);
    await bot.sendMessage(msg.chat.id, "🚫 Sorry, there was an error processing your sticker. Please try again later.");
  }
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

    // Prevent votes from user ID 777000
    if (reactorId === '777000') {
      console.log('Reaction from user 777000 ignored');
      return;
    }

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

// Add error handler with more detail
bot.on('error', (error) => {
  console.error('Bot error:', {
    message: error.message,
    stack: error.stack,
    name: error.name,
    code: error.code
  });
});

// Add webhook error handler
app.use((err, req, res, next) => {
  console.error('Webhook error:', {
    message: err.message,
    stack: err.stack,
    name: err.name
  });
  res.status(500).send('Internal Server Error');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
