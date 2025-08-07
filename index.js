// Database-Free Delivery Bot - Updated with new Token, Driver Group and Admin ID
// Run in Deno

const TELEGRAM_BOT_TOKEN = '8300808943:AAEeQsBOOjQ4XhuNNWe40C5c86kIZFMvzZM';
const DRIVER_GROUP_ID = -2734011708; // Updated driver group ID
const ADMIN_USER_IDS = [5186573916]; // Your admin user ID

// In-memory storage
const activeOrders = new Map();   // orderNumber => orderData
const completedOrders = [];       // last completed orders array
let orderCounter = 1;

// Track connected drivers by userId, updated by commands and chat member updates
const connectedDrivers = new Set();

// Order statuses enum
const ORDER_STATUS = {
  CREATED: 'created',
  ASSIGNED: 'assigned',
  PICKED_UP: 'picked_up',
  ARRIVED: 'arrived',
  COMPLETED: 'completed'
};

// Payment types enum
const PAYMENT_TYPES = {
  CASH: 'cash',
  QRCODE: 'qrcode',
  PAID: 'paid'
};

// CORS headers for webhook
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

// Utils

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function generateOrderNumber() {
  return String(orderCounter++).padStart(4, '0');
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    console.error(`Telegram API error sending message to ${chatId}: ${response.status}`);
    console.error(await response.text());
  }
  return response.json();
}

async function editMessageText(chatId, messageId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function answerCallbackQuery(callbackQueryId, text = 'OK') {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text
    })
  });
}

// ADMIN PANEL FUNCTIONS

async function showAdminMenu(chatId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: '📦 Create New Order', callback_data: 'admin_create_order' }],
      [{ text: '📋 Active Orders', callback_data: 'admin_active_orders' }],
      [{ text: '🚗 Connected Drivers', callback_data: 'admin_connected_drivers' }],
      [{ text: '📊 Recent Orders', callback_data: 'admin_recent_orders' }]
    ]
  };
  await sendTelegramMessage(chatId, '👑 <b>Admin Panel</b>\n\nChoose an option:', keyboard);
}

async function showActiveOrders(chatId) {
  const orders = Array.from(activeOrders.values());
  if (orders.length === 0) {
    await sendTelegramMessage(chatId, '📋 No active orders');
    return;
  }
  const orderList = orders.map(o =>
    `📦 #${o.orderNumber} - <b>${o.status}</b>\n👤 Customer: ${o.customerId || 'Not set'}\n📍 Location: ${o.location || 'Not set'}`
  ).join('\n\n');
  await sendTelegramMessage(chatId, `<b>Active Orders (${orders.length}):</b>\n\n${orderList}`);
}

async function showRecentOrders(chatId) {
  const recent = completedOrders.slice(0, 10);
  if (recent.length === 0) {
    await sendTelegramMessage(chatId, '📊 No recent completed orders');
    return;
  }
  const orderList = recent.map(o =>
    `📦 #${o.orderNumber} - Completed\n👤 Customer: ${o.customerId}\n⏰ ${o.timestamps.completed.toLocaleString()}`
  ).join('\n\n');
  await sendTelegramMessage(chatId, `<b>Recent Completed Orders:</b>\n\n${orderList}`);
}

async function showConnectedDrivers(chatId) {
  if (connectedDrivers.size === 0) {
    await sendTelegramMessage(chatId, '🚗 No drivers are currently connected.');
    return;
  }
  const driverList = Array.from(connectedDrivers)
    .map(id => `• <code>${id}</code>`)
    .join('\n');
  await sendTelegramMessage(chatId, `<b>Connected Drivers (${connectedDrivers.size}):</b>\n\n${driverList}`);
}

// ORDER CREATION & EDITING

async function startOrderCreation(chatId, userId) {
  const orderNumber = generateOrderNumber();
  const orderData = {
    orderNumber,
    customerId: null,
    location: null,
    payment: PAYMENT_TYPES.CASH,
    notes: '',
    status: ORDER_STATUS.CREATED,
    driverId: null,
    adminId: userId,
    timestamps: { created: new Date() },
    waitingFor: null,
    editMessageId: null
  };
  activeOrders.set(orderNumber, orderData);

  const keyboard = editOrderInlineKeyboard(orderData);
  const text = renderOrderDetails(orderData, 'Creating Order');
  const sent = await sendTelegramMessage(chatId, text, keyboard);
  orderData.editMessageId = sent.result.message_id;
}

function editOrderInlineKeyboard(order) {
  const paymentText = order.payment.charAt(0).toUpperCase() + order.payment.slice(1);
  return {
    inline_keyboard: [
      [{ text: '👤 Set Customer ID', callback_data: `edit_customer_${order.orderNumber}` }],
      [{ text: '📍 Set Location', callback_data: `edit_location_${order.orderNumber}` }],
      [{ text: `💳 Payment: ${paymentText}`, callback_data: `edit_payment_${order.orderNumber}` }],
      [{ text: '📝 Add Notes', callback_data: `edit_notes_${order.orderNumber}` }],
      [{ text: '✅ Create Order', callback_data: `confirm_order_${order.orderNumber}` }],
      [{ text: '❌ Cancel', callback_data: `cancel_order_${order.orderNumber}` }]
    ]
  };
}

function renderOrderDetails(order, title = 'Order') {
  return `📦 <b>${title} #${order.orderNumber}</b>\n\n` +
    `👤 Customer ID: ${order.customerId || '<i>Not set</i>'}\n` +
    `📍 Location: ${order.location || '<i>Not set</i>'}\n` +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
    `📝 Notes: ${order.notes || '<i>None</i>'}\n\n` +
    `Use buttons below to edit fields:`;
}

async function updateOrderDisplay(chatId, messageId, orderNumber) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  const keyboard = editOrderInlineKeyboard(order);
  const text = renderOrderDetails(order, 'Creating Order');
  await editMessageText(chatId, messageId, text, keyboard);
}

async function handleOrderEdit(action, orderNumber, chatId, userId, messageId) {
  const order = activeOrders.get(orderNumber);
  if (!order || order.adminId !== userId) return;

  switch(action) {
    case 'customer':
      order.waitingFor = 'customer';
      await sendTelegramMessage(chatId, '👤 Please enter the customer Telegram ID:');
      break;

    case 'location':
      order.waitingFor = 'location';
      await sendTelegramMessage(chatId, '📍 Please enter the location (address or map link):');
      break;

    case 'payment': {
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Cash', callback_data: `set_payment_${order
