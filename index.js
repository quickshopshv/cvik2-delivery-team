// Database-Free Delivery Bot - Fully updated for admin UI fixes & accurate notifications
// Run in Deno

const TELEGRAM_BOT_TOKEN = '8300808943:AAEeQsBOOjQ4XhuNNWe40C5c86kIZFMvzZM';
const DRIVER_GROUP_ID = -2734011708; // Your updated driver group chat ID
const ADMIN_USER_IDS = [5186573916]; // Your Telegram user ID as admin

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

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  // Note: passing empty text disables toasts; pass meaningful text for notifications
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert
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
      // Edit the order message inline keyboard to show payment options
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Cash', callback_data: `set_payment_${orderNumber}_cash` }],
          [{ text: 'QR Code', callback_data: `set_payment_${orderNumber}_qrcode` }],
          [{ text: 'Paid', callback_data: `set_payment_${orderNumber}_paid` }],
          [{ text: '🔙 Back', callback_data: `back_order_${orderNumber}` }]
        ]
      };
      await editMessageText(chatId, messageId, `💳 <b>Select Payment Method for Order #${orderNumber}:</b>`, keyboard);
      break;
    }

    case 'notes':
      order.waitingFor = 'notes';
      await sendTelegramMessage(chatId, '📝 Please enter notes for this order:');
      break;
  }
}

async function handlePaymentSet(orderNumber, payment, chatId, messageId, userId) {
  const order = activeOrders.get(orderNumber);
  if (!order || order.adminId !== userId) return;
  if (!Object.values(PAYMENT_TYPES).includes(payment)) return;
  order.payment = payment;
  order.waitingFor = null;
  await updateOrderDisplay(chatId, messageId, orderNumber);
}

async function confirmOrder(orderNumber, chatId, messageId) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  if (!order.customerId || !order.location) {
    await answerCallbackQuery('', 'Please set Customer ID and Location first!', true);
    return;
  }
  if (connectedDrivers.size === 0) {
    await editMessageText(chatId, messageId, `❌ <b>No drivers connected currently.</b> Please ask drivers to connect.`);
    return;
  }

  // Show driver selection menu with connected drivers
  const keyboard = {
    inline_keyboard: Array.from(connectedDrivers).map(driverId => [{
      text: `🚗 Driver ${driverId}`,
      callback_data: `assign_driver_${orderNumber}_${driverId}`
    }]).concat([
      [{ text: '🔙 Back to Edit', callback_data: `back_order_${orderNumber}` }]
    ])
  };
  const text = `🚗 <b>Select Driver for Order #${orderNumber}:</b>\n\n` +
    `👤 Customer: ${order.customerId}\n` +
    `📍 Location: ${order.location}\n` +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
    `📝 Notes: ${order.notes || 'None'}`;
  await editMessageText(chatId, messageId, text, keyboard);
}

async function assignDriverToOrder(orderNumber, driverId, chatId, messageId) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  if (!connectedDrivers.has(driverId)) {
    await editMessageText(chatId, messageId, `❌ Driver #${driverId} is not connected.`);
    return;
  }

  order.driverId = driverId;
  order.status = ORDER_STATUS.ASSIGNED;
  order.timestamps.assigned = new Date();

  const driverMessage =
    `🚗 <b>New Delivery Order #${orderNumber}</b>\n\n` +
    `📍 Location: ${order.location}\n` +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
    `📝 Notes: ${order.notes || 'None'}\n\n` +
    `Please proceed with the delivery.`;

  await sendTelegramMessage(driverId, driverMessage);

  await editMessageText(chatId, messageId,
    `✅ <b>Order #${orderNumber} Created and Assigned!</b>\n\n` +
    `👤 Customer: ${order.customerId}\n` +
    `📍 Location: ${order.location}\n` +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
    `📝 Notes: ${order.notes || 'None'}\n` +
    `🚗 Driver: ${driverId}\n\n` +
    `Order sent to driver.`);

  const trackingLink = `https://t.me/your_bot_username?start=order_${orderNumber}`;
  await sendTelegramMessage(order.customerId,
    `📦 <b>Your order #${orderNumber} has been created!</b>\n\n` +
    `Track your order: ${trackingLink}\n\n` +
    `You will receive updates as your order progresses.`);
}

async function cancelOrder(orderNumber, chatId, messageId) {
  activeOrders.delete(orderNumber);
  await editMessageText(chatId, messageId, `❌ Order #${orderNumber} cancelled.`);
}

// CUSTOMER ORDER TRACKING

async function handleOrderTracking(chatId, userId, orderNumber) {
  const order = activeOrders.get(orderNumber) || completedOrders.find(o => o.orderNumber === orderNumber);
  if (!order) {
    await sendTelegramMessage(chatId, `❌ Order #${orderNumber} not found.`);
    return;
  }
  if (order.customerId && order.customerId !== userId) {
    await sendTelegramMessage(chatId, `❌ This order belongs to another customer.`);
    return;
  }
  if (!order.customerId) {
    order.customerId = userId; // bind to customer first time
  }

  let statusText = '';
  let etaText = '';

  switch (order.status) {
    case ORDER_STATUS.CREATED:
      statusText = '📦 Order created, waiting for driver assignment';
      break;
    case ORDER_STATUS.ASSIGNED:
      statusText = '🚗 Driver assigned, preparing for pickup';
      etaText = 'ETA: 5-10 minutes for pickup';
      break;
    case ORDER_STATUS.PICKED_UP:
      statusText = '🛣️ Order picked up, on the way to you';
      etaText = 'ETA: 15-30 minutes for delivery';
      break;
    case ORDER_STATUS.ARRIVED:
      statusText = '🏁 Driver has arrived at your location';
      break;
    case ORDER_STATUS.COMPLETED:
      statusText = '✅ Order delivered successfully';
      break;
  }

  const keyboard = order.status !== ORDER_STATUS.COMPLETED ? {
    inline_keyboard: [
      [{ text: '🔄 Refresh Status', callback_data: `track_${orderNumber}` }]
    ]
  } : {
    inline_keyboard: [
      [{ text: '⭐ Rate Experience', callback_data: `show_feedback_${orderNumber}` }]
    ]
  };

  let message = `📋 <b>Order #${orderNumber} Status</b>\n\n${statusText}\n\n` +
    `📍 Location: ${order.location}\n` +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
    `📝 Notes: ${order.notes || 'None'}`;
  if (etaText) {
    message += `\n\n⏰ ${etaText}`;
  }

  await sendTelegramMessage(chatId, message, keyboard);
}

// DRIVER GROUP MESSAGE HANDLER (connect / disconnect via commands or buttons)

async function handleDriverGroupMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text?.toLowerCase();

  if (chatId !== DRIVER_GROUP_ID) return;

  if (!text || text === '/start') {
    await sendDriverStatusKeyboard(chatId, userId);
    return;
  }

  if (text === '/connect' || text === 'connect') {
    if (connectedDrivers.has(userId)) {
      await sendTelegramMessage(chatId, `🚗 You are already connected as a driver.`);
      return;
    }
    connectedDrivers.add(userId);
    await sendTelegramMessage(chatId, `✅ You are now connected as a driver. You will receive delivery orders in private chat.`);
    for (const adminId of ADMIN_USER_IDS) {
      await sendTelegramMessage(adminId, `🚗 Driver ${userId} connected.`);
    }
    await sendDriverStatusKeyboard(chatId, userId);
    return;
  }

  if (text === '/disconnect' || text === 'disconnect') {
    if (connectedDrivers.delete(userId)) {
      await sendTelegramMessage(chatId, `✅ You are now disconnected and will no longer receive orders.`);
      for (const adminId of ADMIN_USER_IDS) {
        await sendTelegramMessage(adminId, `🚗 Driver ${userId} disconnected.`);
      }
    } else {
      await sendTelegramMessage(chatId, `ℹ️ You were not connected.`);
    }
    await sendDriverStatusKeyboard(chatId, userId);
    return;
  }
}

async function sendDriverStatusKeyboard(chatId, userId) {
  const isConnected = connectedDrivers.has(userId);
  const keyboard = {
    inline_keyboard: [[{
      text: isConnected ? '❌ Disconnect' : '✅ Connect',
      callback_data: isConnected ? 'driver_disconnect' : 'driver_connect'
    }]]
  };

  await sendTelegramMessage(chatId,
    isConnected ? '🚗 You are currently connected as a driver.' : '🚗 You are currently disconnected.', keyboard);
}

// CHAT MEMBER UPDATE HANDLER - monitor driver group join / leave to update connectedDrivers

async function handleChatMemberUpdate(update) {
  if (!('chat_member' in update) && !('my_chat_member' in update)) return;
  const chatMember = update.chat_member || update.my_chat_member;
  const chatId = chatMember.chat.id;
  if (chatId !== DRIVER_GROUP_ID) return;

  const userId = chatMember.from?.id || chatMember.new_chat_member?.user?.id;
  if (!userId) return;

  const newStatus = chatMember.new_chat_member?.status || chatMember.new_chat_member_status || chatMember.new_chat_member?.status;

  if (newStatus === 'left' || newStatus === 'kicked') {
    if (connectedDrivers.has(userId)) {
      connectedDrivers.delete(userId);
      for (const adminId of ADMIN_USER_IDS) {
        await sendTelegramMessage(adminId, `🚗 Driver ${userId} left or was removed from driver group, marked as disconnected.`);
      }
    }
  } else if (newStatus === 'member' || newStatus === 'restricted') {
    for (const adminId of ADMIN_USER_IDS) {
      await sendTelegramMessage(adminId, `🚗 Driver ${userId} joined or re-joined driver group.`);
    }
  }
}

// DRIVER ORDER STATUS UPDATE (via commands in private chat)

async function handleDriverStatusUpdate(command, userId, chatId, orderNumber) {
  if (!connectedDrivers.has(userId)) {
    await sendTelegramMessage(chatId, `❌ You are not connected as a driver.`);
    return;
  }
  const order = activeOrders.get(orderNumber);
  if (!order) {
    await sendTelegramMessage(chatId, `❌ Order #${orderNumber} not found.`);
    return;
  }
  if (order.driverId !== userId) {
    await sendTelegramMessage(chatId, `❌ You are not assigned to order #${orderNumber}.`);
    return;
  }

  switch(command){
    case 'pickedup':
      order.status = ORDER_STATUS.PICKED_UP;
      order.timestamps.picked_up = new Date();
      await sendTelegramMessage(chatId, `✅ Marked order #${orderNumber} as picked up.`);
      await sendTelegramMessage(order.customerId, `📦 Your order #${orderNumber} has been picked up and is on the way!`);
      break;

    case 'arrived':
      order.status = ORDER_STATUS.ARRIVED;
      order.timestamps.arrived = new Date();
      await sendTelegramMessage(chatId, `✅ Marked order #${orderNumber} as arrived.`);
      await sendTelegramMessage(order.customerId, `🚗 Your driver has arrived for order #${orderNumber}.`);
      break;

    case 'completed':
      order.status = ORDER_STATUS.COMPLETED;
      order.timestamps.completed = new Date();
      await sendTelegramMessage(chatId, `✅ Marked order #${orderNumber} as completed. Great job!`);
      await sendTelegramMessage(order.customerId, `✅ Your order #${orderNumber} has been delivered! Thank you.`);
      completedOrders.unshift(order);
      activeOrders.delete(orderNumber);
      break;

    default:
      await sendTelegramMessage(chatId, `❌ Unknown driver command.`);
  }
}

// MAIN WEBHOOK HANDLER

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.get('setup')) {
      const webhookUrl = `https://cvik2-driver-team-x7a5j67m1qxc.quickshopshv.deno.net/`; // Replace with your actual deploy URL
      const setWebhookResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl })
      });
      const result = await setWebhookResponse.json();
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    return new Response('Database-Free Delivery Bot is running!', { headers: corsHeaders });
  }

  try {
    const update = await req.json();

    if ('chat_member' in update || 'my_chat_member' in update) {
      await handleChatMemberUpdate(update);
      return new Response('OK', { headers: corsHeaders });
    }

    if (update.message) {
      const message = update.message;
      const chatId = message.chat.id;
      const userId = message.from.id;
      const text = message.text || '';

      if (chatId === DRIVER_GROUP_ID) {
        await handleDriverGroupMessage(message);
        return new Response('OK', { headers: corsHeaders });
      }

      if (isAdmin(userId)) {
        if (text.startsWith('/start')) {
          await showAdminMenu(chatId);
          return new Response('OK', { headers: corsHeaders });
        }
        for (const [orderNumber, order] of activeOrders.entries()) {
          if (order.adminId === userId && order.waitingFor) {
            switch (order.waitingFor) {
              case 'customer':
                order.customerId = parseInt(text) || text;
                break;
              case 'location':
                order.location = text;
                break;
              case 'notes':
                order.notes = text;
                break;
            }
            order.waitingFor = null;
            await updateOrderDisplay(chatId, order.editMessageId, orderNumber);
            return new Response('OK', { headers: corsHeaders });
          }
        }
      }

      if (chatId > 0 && !isAdmin(userId) && connectedDrivers.has(userId)) {
        const parts = text.trim().split(' ');
        const command = parts[0].replace('/', '').toLowerCase();
        const orderNumber = parts[1];
        if (['pickedup', 'arrived', 'completed'].includes(command) && orderNumber) {
          await handleDriverStatusUpdate(command, userId, chatId, orderNumber);
          return new Response('OK', { headers: corsHeaders });
        }
      }

      if (/^\d{4}$/.test(text.trim())) {
        await handleOrderTracking(chatId, userId, text.trim());
        return new Response('OK', { headers: corsHeaders });
      }
    }

    if (update.callback_query) {
      const data = update.callback_query.data;
      const userId = update.callback_query.from.id;
      const messageId = update.callback_query.message?.message_id;
      const chatId = update.callback_query.message?.chat.id;

      if (chatId === DRIVER_GROUP_ID) {
        if (data === 'driver_connect') {
          if (!connectedDrivers.has(userId)) {
            connectedDrivers.add(userId);
            await sendTelegramMessage(chatId, `✅ You are now connected as a driver. You will receive orders in private chat.`);
            for (const adminId of ADMIN_USER_IDS) {
              await sendTelegramMessage(adminId, `🚗 Driver ${userId} connected.`);
            }
          } else {
            await sendTelegramMessage(chatId, `🚗 You are already connected.`);
          }
          await answerCallbackQuery(update.callback_query.id);
          return new Response('OK', { headers: corsHeaders });
        } else if (data === 'driver_disconnect') {
          if (connectedDrivers.delete(userId)) {
            await sendTelegramMessage(chatId, `✅ You are now disconnected.`);
            for (const adminId of ADMIN_USER_IDS) {
              await sendTelegramMessage(adminId, `🚗 Driver ${userId} disconnected.`);
            }
          } else {
            await sendTelegramMessage(chatId, `ℹ️ You were not connected.`);
          }
          await answerCallbackQuery(update.callback_query.id);
          return new Response('OK', { headers: corsHeaders });
        } else {
          await answerCallbackQuery(update.callback_query.id);
          return new Response('OK', { headers: corsHeaders });
        }
      }

      if (isAdmin(userId)) {
        if (data === 'admin_create_order') {
          await startOrderCreation(chatId, userId);
          await answerCallbackQuery(update.callback_query.id, '✅ New order creation started.');
        } else if (data === 'admin_active_orders') {
          await showActiveOrders(chatId);
          await answerCallbackQuery(update.callback_query.id);
        } else if (data === 'admin_connected_drivers') {
          await showConnectedDrivers(chatId);
          await answerCallbackQuery(update.callback_query.id);
        } else if (data === 'admin_recent_orders') {
          await showRecentOrders(chatId);
          await answerCallbackQuery(update.callback_query.id);
        } else if (data.startsWith('edit_')) {
          const [_, field, orderNumber] = data.split('_');
          await handleOrderEdit(field, orderNumber, chatId, userId, messageId);
          // Use empty text to avoid annoying "ok" toast if UI updated, else a short notification
          if (field === 'payment') {
            await answerCallbackQuery(update.callback_query.id);
          } else {
            await answerCallbackQuery(update.callback_query.id, `Ready to enter ${field} input.`);
          }
        } else if (data.startsWith('set_payment_')) {
          const [, , orderNumber, payment] = data.split('_');
          await handlePaymentSet(orderNumber, payment, chatId, messageId, userId);
          await answerCallbackQuery(update.callback_query.id, `Payment set to ${payment}`);
        } else if (data.startsWith('back_order_')) {
          const orderNumber = data.split('_')[2];
          await updateOrderDisplay(chatId, messageId, orderNumber);
          await answerCallbackQuery(update.callback_query.id, 'Back to order edit.');
        } else if (data.startsWith('confirm_order_')) {
          const orderNumber = data.split('_')[2];
          await confirmOrder(orderNumber, chatId, messageId);
          await answerCallbackQuery(update.callback_query.id, 'Select a driver for assignment.');
        } else if (data.startsWith('cancel_order_')) {
          const orderNumber = data.split('_')[2];
          await cancelOrder(orderNumber, chatId, messageId);
          await answerCallbackQuery(update.callback_query.id, 'Order cancelled.');
        } else if (data.startsWith('assign_driver_')) {
          const [, , orderNumber, driverIdStr] = data.split('_');
          const driverId = parseInt(driverIdStr);
          await assignDriverToOrder(orderNumber, driverId, chatId, messageId);
          await answerCallbackQuery(update.callback_query.id, 'Driver assigned.');
        } else {
          await answerCallbackQuery(update.callback_query.id);
        }
      } else {
        // For non-admin users clicking on admin callbacks - just acknowledge silently
        await answerCallbackQuery(update.callback_query.id);
      }
    }

    return new Response('OK', { headers: corsHeaders });
  } catch (error) {
    console.error('Error processing update:', error);
    return new Response('Error', { status: 500, headers: corsHeaders });
  }
});
