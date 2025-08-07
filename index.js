// Database-Free Delivery Bot with full admin and driver group support
// Run with Deno

const TELEGRAM_BOT_TOKEN = '8300808943:AAEeQsBOOjQ4XhuNNWe40C5c86kIZFMvzZM';
const DRIVER_GROUP_ID = -2734011708; // Your driver group chat ID
const ADMIN_USER_IDS = [5186573916]; // Telegram user IDs of admins

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const activeOrders = new Map();
const completedOrders = [];
const connectedDrivers = new Set();

const ORDER_STATUS = {
  CREATED: 'created',
  ASSIGNED: 'assigned',
  PICKED_UP: 'picked_up',
  ARRIVED: 'arrived',
  COMPLETED: 'completed'
};

const PAYMENT_TYPES = {
  CASH: 'cash',
  QRCODE: 'qrcode',
  PAID: 'paid'
};

let orderCounter = 1;

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function generateOrderNumber() {
  return String(orderCounter++).padStart(4, '0');
}

async function sendTelegramMessage(chatId, text, replyMarkup = null, disableWebPagePreview = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: disableWebPagePreview };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!resp.ok) console.error('Telegram sendMessage error:', await resp.text());
  return resp.json();
}

async function editMessageText(chatId, messageId, text, replyMarkup = null, disableWebPagePreview = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: disableWebPagePreview };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return resp.json();
}

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert })
  });
}

function tgUserLink(user) {
  if (user.username) return `<a href="https://t.me/${user.username}">${user.first_name || 'User'}</a>`;
  return `<a href="tg://user?id=${user.id}">${user.first_name || 'User'}</a>`;
}

function renderOrderDetails(order, title = 'Order', customerUser = null) {
  const customerNameLink = customerUser ? tgUserLink(customerUser) : `<code>${order.customerId}</code>`;
  const notesText = order.notes && order.notes.trim() !== '' ? order.notes : '';
  return `📦 <b>${title} #${order.orderNumber}</b>\n\n` +
    `👤 Customer: ${customerNameLink}\n` +
    `📍 Location: ${order.location}\n` +
    (notesText ? `📝 Notes: ${notesText}\n` : '') +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}`;
}

function adminMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📦 Create New Order', callback_data: 'admin_create_order' }],
      [{ text: '📋 Active Orders', callback_data: 'admin_active_orders' }],
      [{ text: '🚗 Connected Drivers', callback_data: 'admin_connected_drivers' }],
      [{ text: '📊 Recent Orders', callback_data: 'admin_recent_orders' }]
    ]
  };
}

function orderEditKeyboard(order) {
  return {
    inline_keyboard: [
      [{ text: '👤 Set Customer ID', callback_data: `edit_customer_${order.orderNumber}` }],
      [{ text: '📍 Set Location', callback_data: `edit_location_${order.orderNumber}` }],
      [{ text: `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}`, callback_data: `edit_payment_${order.orderNumber}` }],
      [{ text: '📝 Add Notes', callback_data: `edit_notes_${order.orderNumber}` }],
      [{ text: '✅ Create Order', callback_data: `confirm_order_${order.orderNumber}` }],
      [{ text: '❌ Cancel', callback_data: `cancel_order_${order.orderNumber}` }]
    ]
  };
}

function driverStatusKeyboard(userId) {
  const isConnected = connectedDrivers.has(userId);
  return {
    inline_keyboard: [[{
      text: isConnected ? '❌ Disconnect' : '✅ Connect',
      callback_data: isConnected ? 'driver_disconnect' : 'driver_connect'
    }]]
  };
}

async function updateOrderDisplay(chatId, messageId, orderNumber) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  const text = renderOrderDetails(order, 'Order Draft');
  const keyboard = orderEditKeyboard(order);
  await editMessageText(chatId, messageId, text, keyboard, true);
}

async function showAdminMenu(chatId) {
  await sendTelegramMessage(chatId, '👑 <b>Admin Panel</b>\n\nChoose an option:', adminMainMenuKeyboard());
}

async function showActiveOrders(chatId) {
  const orders = Array.from(activeOrders.values());
  if (orders.length === 0) {
    await sendTelegramMessage(chatId, '📋 No active orders.');
    return;
  }
  let text = `<b>Active Orders (${orders.length}):</b>\n\n`;
  for (const o of orders) {
    text += `📦 #${o.orderNumber} - <b>${o.status}</b>\n` + `👤 Customer ID: <code>${o.customerId}</code>\n` + `📍 Location: ${o.location}\n\n`;
  }
  await sendTelegramMessage(chatId, text);
}

async function showRecentOrders(chatId) {
  const recent = completedOrders.slice(0, 10);
  if (recent.length === 0) {
    await sendTelegramMessage(chatId, '📊 No recent completed orders.');
    return;
  }
  let text = '<b>Recent Completed Orders:</b>\n\n';
  for (const o of recent) {
    text += `📦 #${o.orderNumber} - Completed\n👤 Customer ID: <code>${o.customerId}</code>\n` + `⏰ ${o.timestamps.completed.toLocaleString()}\n\n`;
  }
  await sendTelegramMessage(chatId, text);
}

async function showConnectedDrivers(chatId) {
  if (connectedDrivers.size === 0) {
    await sendTelegramMessage(chatId, '🚗 No drivers currently connected.');
    return;
  }
  const driversList = Array.from(connectedDrivers).map(id => `• <code>${id}</code>`).join('\n');
  await sendTelegramMessage(chatId, `<b>Connected Drivers (${connectedDrivers.size}):</b>\n\n${driversList}`);
}

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
  const keyboard = orderEditKeyboard(orderData);
  const text = renderOrderDetails(orderData, 'Creating Order');
  const sent = await sendTelegramMessage(chatId, text, keyboard, true);
  orderData.editMessageId = sent.result.message_id;
}

async function handleOrderEdit(action, orderNumber, chatId, userId, messageId) {
  const order = activeOrders.get(orderNumber);
  if (!order || order.adminId !== userId) return;

  switch (action) {
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
          [{ text: 'Cash', callback_data: `set_payment_${orderNumber}_cash` }],
          [{ text: 'QR Code', callback_data: `set_payment_${orderNumber}_qrcode` }],
          [{ text: 'Paid', callback_data: `set_payment_${orderNumber}_paid` }],
          [{ text: '🔙 Back', callback_data: `back_order_${orderNumber}` }]
        ]
      };
      await editMessageText(chatId, messageId, `💳 <b>Select Payment Method for Order #${orderNumber}:</b>`, keyboard, true);
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
    await sendTelegramMessage(chatId, '❌ Please set Customer ID and Location first.');
    return;
  }
  if (connectedDrivers.size === 0) {
    await editMessageText(chatId, messageId, `❌ <b>No drivers connected currently.</b> Please ask drivers to connect.`);
    return;
  }
  const keyboard = {
    inline_keyboard: Array.from(connectedDrivers).map(driverId => [{
      text: `🚗 Driver ${driverId}`,
      callback_data: `assign_driver_${orderNumber}_${driverId}`
    }]).concat([[{ text: '🔙 Back to Edit', callback_data: `back_order_${orderNumber}` }]])
  };
  const text =
    `🚗 <b>Select Driver for Order #${orderNumber}:</b>\n\n` +
    `👤 Customer ID: <code>${order.customerId}</code>\n` +
    `📍 Location: ${order.location}\n` +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
    `📝 Notes: ${order.notes || ''}`;
  await editMessageText(chatId, messageId, text, keyboard, true);
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
    (order.notes ? `📝 Notes: ${order.notes}\n` : '') +
    `\nPlease proceed with the delivery.`;

  await sendTelegramMessage(driverId, driverMessage);

  await editMessageText(chatId, messageId,
    `✅ <b>Order #${orderNumber} Created and Assigned!</b>\n\n` +
    `👤 Customer ID: <code>${order.customerId}</code>\n` +
    `📍 Location: ${order.location}\n` +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
    (order.notes ? `📝 Notes: ${order.notes}\n` : '') +
    `🚗 Driver: ${driverId}\n\n` +
    `Order sent to driver.`);

  activeOrders.delete(orderNumber);
}

async function cancelOrder(orderNumber, chatId, messageId) {
  activeOrders.delete(orderNumber);
  await editMessageText(chatId, messageId, `❌ Order #${orderNumber} cancelled.`);
}

async function handleDriverGroupMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = (message.text || '').toLowerCase().trim();

  if (chatId !== DRIVER_GROUP_ID) return;

  const isConnected = connectedDrivers.has(userId);
  const keyboard = driverStatusKeyboard(userId);

  if (text === '/start' || text === '/status') {
    await sendTelegramMessage(chatId, isConnected ? '🚗 You are currently connected.' : '🚗 You are currently disconnected.', keyboard);
    return;
  }

  if (text === '/connect') {
    if (isConnected) {
      await sendTelegramMessage(chatId, '🚗 You are already connected.', keyboard);
      return;
    }
    connectedDrivers.add(userId);
    await sendTelegramMessage(chatId, '✅ You are now connected as a driver.', keyboard);
    for (const adminId of ADMIN_USER_IDS) {
      await sendTelegramMessage(adminId, `🚗 Driver ${userId} connected.`);
    }
    return;
  }

  if (text === '/disconnect') {
    if (!isConnected) {
      await sendTelegramMessage(chatId, 'ℹ️ You were not connected.', keyboard);
      return;
    }
    connectedDrivers.delete(userId);
    await sendTelegramMessage(chatId, '✅ You are now disconnected.', keyboard);
    for (const adminId of ADMIN_USER_IDS) {
      await sendTelegramMessage(adminId, `🚗 Driver ${userId} disconnected.`);
    }
    return;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method === 'GET') return new Response('Database-Free Delivery Bot is running!', { headers: corsHeaders });

  try {
    const update = await req.json();

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
        if (text.trim() === '/start') {
          await showAdminMenu(chatId);
          return new Response('OK', { headers: corsHeaders });
        }

        // Forwarded message for order creation
        if (message.forward_from && message.forward_from.id !== userId) {
          const customerUser = message.forward_from;
          const customerId = customerUser.id;

          const lines = text.trim().split('\n');
          let location = lines[0];
          let notes = '';
          if (lines.length > 1) notes = lines.slice(1).join('\n').trim();

          const orderNumber = generateOrderNumber();
          const newOrder = {
            orderNumber,
            customerId,
            location,
            payment: PAYMENT_TYPES.CASH,
            notes,
            status: ORDER_STATUS.CREATED,
            driverId: null,
            adminId: userId,
            timestamps: { created: new Date() },
            waitingFor: null,
            editMessageId: null
          };

          activeOrders.set(orderNumber, newOrder);

          const orderText = `📦 <b>New Order Draft #${orderNumber}</b>\n\n` +
            `👤 Customer: ${tgUserLink(customerUser)}\n` +
            `📍 Location: ${location}\n` +
            (notes ? `📝 Notes: ${notes}\n` : '') +
            `<b>Choose an action:</b>`;

          const keyboard = {
            inline_keyboard: [
              [{ text: '💳 Set Payment', callback_data: `edit_payment_${orderNumber}` }],
              [{ text: '✅ Create Order', callback_data: `confirm_order_${orderNumber}` }]
            ]
          };

          const sent = await sendTelegramMessage(chatId, orderText, keyboard, true);
          newOrder.editMessageId = sent.result.message_id;

          return new Response('OK', { headers: corsHeaders });
        }

        // Admin input for waitingFor fields
        for (const [orderNumber, order] of activeOrders.entries()) {
          if (order.adminId === userId && order.waitingFor) {
            switch (order.waitingFor) {
              case 'customer': order.customerId = parseInt(text) || text; break;
              case 'location': order.location = text; break;
              case 'notes': order.notes = text; break;
            }
            order.waitingFor = null;
            await updateOrderDisplay(chatId, order.editMessageId, orderNumber);
            return new Response('OK', { headers: corsHeaders });
          }
        }
      }

      return new Response('OK', { headers: corsHeaders });
    }

    if (update.callback_query) {
      const data = update.callback_query.data;
      const callbackQueryId = update.callback_query.id;
      const userId = update.callback_query.from.id;
      const message = update.callback_query.message;
      const chatId = message.chat.id;
      const messageId = message.message_id;

      if (chatId === DRIVER_GROUP_ID) {
        if (data === 'driver_connect') {
          if (!connectedDrivers.has(userId)) {
            connectedDrivers.add(userId);
            await sendTelegramMessage(chatId, '✅ You are now connected.', driverStatusKeyboard(userId));
            for (const adminId of ADMIN_USER_IDS) {
              await sendTelegramMessage(adminId, `🚗 Driver ${userId} connected.`);
            }
          } else {
            await sendTelegramMessage(chatId, '🚗 You are already connected.', driverStatusKeyboard(userId));
          }
          await answerCallbackQuery(callbackQueryId);
          return new Response('OK', { headers: corsHeaders });
        }
        if (data === 'driver_disconnect') {
          if (connectedDrivers.delete(userId)) {
            await sendTelegramMessage(chatId, '✅ You are now disconnected.', driverStatusKeyboard(userId));
            for (const adminId of ADMIN_USER_IDS) {
              await sendTelegramMessage(adminId, `🚗 Driver ${userId} disconnected.`);
            }
          } else {
            await sendTelegramMessage(chatId, 'ℹ️ You were not connected.', driverStatusKeyboard(userId));
          }
          await answerCallbackQuery(callbackQueryId);
          return new Response('OK', { headers: corsHeaders });
        }
      }

      if (!isAdmin(userId)) {
        await answerCallbackQuery(callbackQueryId, 'Unauthorized', true);
        return new Response('OK', { headers: corsHeaders });
      }

      switch (true) {
        case data === 'admin_create_order':
          await startOrderCreation(chatId, userId);
          await answerCallbackQuery(callbackQueryId, 'Starting new order...');
          break;
        case data === 'admin_active_orders':
          await showActiveOrders(chatId);
          await answerCallbackQuery(callbackQueryId);
          break;
        case data === 'admin_connected_drivers':
          await showConnectedDrivers(chatId);
          await answerCallbackQuery(callbackQueryId);
          break;
        case data === 'admin_recent_orders':
          await showRecentOrders(chatId);
          await answerCallbackQuery(callbackQueryId);
          break;
        case data.startsWith('edit_'): {
          const [_, field, orderNumber] = data.split('_');
          await handleOrderEdit(field, orderNumber, chatId, userId, messageId);
          if (field === 'payment') await answerCallbackQuery(callbackQueryId);
          else await answerCallbackQuery(callbackQueryId, `Ready to enter ${field}.`);
          break;
        }
        case data.startsWith('set_payment_'): {
          const [, , orderNumber, payment] = data.split('_');
          await handlePaymentSet(orderNumber, payment, chatId, messageId, userId);
          await answerCallbackQuery(callbackQueryId, `Payment set to ${payment}`);
          break;
        }
        case data.startsWith('back_order_'): {
          const orderNumber = data.split('_')[2];
          await updateOrderDisplay(chatId, messageId, orderNumber);
          await answerCallbackQuery(callbackQueryId, 'Back to order edit.');
          break;
        }
        case data.startsWith('confirm_order_'): {
          const orderNumber = data.split('_')[2];
          await confirmOrder(orderNumber, chatId, messageId);
          await answerCallbackQuery(callbackQueryId);
          break;
        }
        case data.startsWith('cancel_order_'): {
          const orderNumber = data.split('_')[2];
          await cancelOrder(orderNumber, chatId, messageId);
          await answerCallbackQuery(callbackQueryId, 'Order cancelled.');
          break;
        }
        case data.startsWith('assign_driver_'): {
          const [, , orderNumber, driverIdStr] = data.split('_');
          const driverId = parseInt(driverIdStr);
          await assignDriverToOrder(orderNumber, driverId, chatId, messageId);
          await answerCallbackQuery(callbackQueryId, 'Driver assigned.');
          break;
        }
        default:
          await answerCallbackQuery(callbackQueryId);
      }
      return new Response('OK', { headers: corsHeaders });
    }

    return new Response('OK', { headers: corsHeaders });
  } catch (e) {
    console.error('Error processing update:', e);
    return new Response('Internal Server Error', { status: 500, headers: corsHeaders });
  }
});
