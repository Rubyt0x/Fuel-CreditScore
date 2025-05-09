# The Fuel Social Credit System

A Telegram bot and web dashboard for managing social credit scores in group chats.

## Features

- Telegram bot integration
- Real-time credit score tracking
- Web dashboard for score visualization
- Leaderboard system
- MongoDB database for persistent storage

## Prerequisites

- Node.js (v14 or higher)
- MongoDB (local or Atlas)
- Telegram Bot Token

## Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd fuel-credit-score
```

2. Install dependencies:
```bash
npm run install-all
```

3. Create a `.env` file in the root directory with the following variables:
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
MONGODB_URI=your_mongodb_uri
PORT=3000
```

4. Start the backend server:
```bash
npm run dev
```

5. In a new terminal, start the frontend:
```bash
cd frontend
npm start
```

## Telegram Bot Commands

- `/start` - Register and get your initial score
- `/score` - Check your current credit score
- `/leaderboard` - View the top 10 scores

## Web Dashboard

The web dashboard is available at `http://localhost:3000` and provides:
- Real-time leaderboard
- User score tracking
- Visual representation of scores

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## License

This project is licensed under the MIT License. 