// Full Delivery Bot with stable admin panel, order draft, driver buttons, feedback, timers
// Run with Deno Deploy or similar environment

const TELEGRAM_BOT_TOKEN = '8300808943:AAEeQsBOOjQ4XhuNNWe40C5c86kIZFMvzZM';
const ADMIN_USER_IDS = [5186573916];  // Replace with your Telegram user ID(s)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const activeOrders = new Map();    // orderNumber -> order object
const completedOrders = [];        // list of completed orders for history/log
const connectedDrivers = new Set();

const ORDER_STATUS = {
  CREATED: 'created',
  ASSIGNED: 'assigned',
  PICKED_UP: 'picked_up',
  ARRIVED: 'arrived',
  COMPLETED: 'completed',
};

const PAYMENT_TYPES = {
  CASH: 'cash',
  QRCODE: 'qrcode',
  PAID: 'paid',
};

let orderCounter = 1;

// Pickup timers: orderNumber -> TimeoutId
const pickupTimers = new Map();
// Feedback sessions: driverId -> orderNumber
const feedbackSessions = new Map();
// Waiting for driver feedback notes: driverId -> orderNumber
const feedbackNotesWaiting = new Map();

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function generateOrderNumber() {
  return String(orderCounter++).padStart(4, '0');
}

function escapeHTML(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function tgUserLink(user) {
  if (!user) return '<i>Unknown User</i>';
  if (user.username) return `<a href="https://t.me/${user.username}">${escapeHTML(user.first_name || 'User')}</a>`;
  return `<a href="tg://user?id=${user.id}">${escapeHTML(user.first_name || 'User')}</a>`;
}

async function sendTelegramMessage(chatId, text, replyMarkup = null, disableWebPagePreview = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: disableWebPagePreview,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    console.error('Telegram sendMessage error:', await resp.text());
  }

  return resp.json();
}

async function editMessageText(chatId, messageId, text, replyMarkup = null, disableWebPagePreview = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: disableWebPagePreview,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return resp.json();
}

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert }),
  });
}

function renderOrderDetails(order, title = 'Order', customerUser = null, driverUser = null) {
  const customerNameLink = customerUser ? tgUserLink(customerUser) : `<code>${order.customerId}</code>`;
  const notesText = order.notes && order.notes.trim() !== '' ? order.notes : '';
  return `📦 <b>${title} #${order.orderNumber}</b>\n\n` +
    `👤 Customer: ${customerNameLink}\n` +
    `📍 Location: ${escapeHTML(order.location)}\n` +
    (notesText ? `📝 Notes: ${escapeHTML(notesText)}\n` : '') +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
    (driverUser ? `🚗 Driver: ${tgUserLink(driverUser)}\n` : '');
}

function adminMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📦 Create New Order', callback_data: 'admin_create_order' }],
      [{ text: '📋 Active Orders', callback_data: 'admin_active_orders' }],
      [{ text: '🚗 Connected Drivers', callback_data: 'admin_connected_drivers' }],
      [{ text: '📊 Recent Orders', callback_data: 'admin_recent_orders' }],
    ],
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
      [{ text: '❌ Cancel', callback_data: `cancel_order_${order.orderNumber}` }],
    ],
  };
}

function driverOrderButtons(orderNumber) {
  return {
    inline_keyboard: [
      [{ text: '🚚 Pickup', callback_data: `pickup_${orderNumber}` }],
      [{ text: '📢 Notify', callback_data: `notify_${orderNumber}` }],
      [{ text: '📍 Arrived', callback_data: `arrived_${orderNumber}` }],
      [{ text: '✅ Completed', callback_data: `completed_${orderNumber}` }],
    ],
  };
}

async function updateOrderDisplay(chatId, messageId, orderNumber) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  const text = renderOrderDetails(order, 'Order Draft');
  const keyboard = orderEditKeyboard(order);
  await editMessageText(chatId, messageId, text, keyboard, true);
}

async function sendOrderToDriver(driverId, orderNumber) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  const driverUser = { id: driverId, first_name: `Driver ${driverId}` };
  const text = renderOrderDetails(order, 'New Delivery Order', null, driverUser);
  await sendTelegramMessage(driverId, text, driverOrderButtons(orderNumber), true);
}

async function notifyAdmins(text) {
  for (const adminId of ADMIN_USER_IDS) {
    await sendTelegramMessage(adminId, text);
  }
}

// Main webhook handler
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method === 'GET') return new Response('Delivery Bot Running', { headers: corsHeaders });

  try {
    const update = await req.json();

    // MESSAGE handling
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const textRaw = msg.text || '';
      const text = textRaw.trim();

      // Driver connect/disconnect/status commands (private chat only)
      if (chatId > 0 && !isAdmin(userId)) {
        const textLower = text.toLowerCase();
        if (textLower === '/connect') {
          if (connectedDrivers.has(userId)) {
            await sendTelegramMessage(chatId, '🚗 You are already connected.');
          } else {
            connectedDrivers.add(userId);
            await sendTelegramMessage(chatId, '✅ You are now connected.');
            await notifyAdmins(`🚗 Driver ${userId} connected.`);
          }
          return new Response('OK', { headers: corsHeaders });
        }
        if (textLower === '/disconnect') {
          if (!connectedDrivers.has(userId)) {
            await sendTelegramMessage(chatId, 'ℹ️ You were not connected.');
          } else {
            connectedDrivers.delete(userId);
            await sendTelegramMessage(chatId, '✅ You are now disconnected.');
            await notifyAdmins(`🚗 Driver ${userId} disconnected.`);
          }
          return new Response('OK', { headers: corsHeaders });
        }
        if (textLower === '/status') {
          await sendTelegramMessage(chatId, connectedDrivers.has(userId) ? '✅ You are connected.' : '❌ You are disconnected.');
          return new Response('OK', { headers: corsHeaders });
        }
      }

      // Admin commands & forwarding message to create orders
      if (isAdmin(userId)) {
        if (text.toLowerCase() === '/start') {
          await sendTelegramMessage(chatId, '👑 <b>Admin Panel</b>', adminMainMenuKeyboard());
          return new Response('OK', { headers: corsHeaders });
        }

        if (msg.forward_from && msg.forward_from.id !== userId && chatId > 0) {
          const customerUser = msg.forward_from;
          const customerId = customerUser.id;
          const lines = text.split('\n');
          const location = lines[0].trim();
          const notes = lines.length > 1 ? lines.slice(1).join('\n').trim() : '';
          const orderNumber = generateOrderNumber();
          const newOrder = {
            orderNumber,
            customerId,
            location,
            payment: PAYMENT_TYPES.PAID,
            notes,
            status: ORDER_STATUS.CREATED,
            driverId: null,
            adminId: userId,
            timestamps: { created: new Date() },
            waitingFor: null,
            editMessageId: null,
          };

          activeOrders.set(orderNumber, newOrder);

          const orderText =
            `📦 <b>New Order Draft #${orderNumber}</b>\n\n` +
            `👤 Customer: ${tgUserLink(customerUser)}\n` +
            `📍 Location: ${escapeHTML(location)}\n` +
            (notes ? `📝 Notes: ${escapeHTML(notes)}\n` : '') +
            `💳 Payment: Paid\n` +
            `<b>Choose an action:</b>`;

          const keyboard = {
            inline_keyboard: [
              [{ text: '💳 Set Payment', callback_data: `edit_payment_${orderNumber}` }],
              [{ text: '✅ Create Order', callback_data: `confirm_order_${orderNumber}` }],
            ],
          };

          const sent = await sendTelegramMessage(chatId, orderText, keyboard, true);
          newOrder.editMessageId = sent.result.message_id;

          return new Response('OK', { headers: corsHeaders });
        }

        // Admin input replies for waiting fields (customerId, location, notes)
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
      return new Response('OK', { headers: corsHeaders });
    }

    // CALLBACK_QUERY handling
    if (update.callback_query) {
      const data = update.callback_query.data;
      const callbackQueryId = update.callback_query.id;
      const userId = update.callback_query.from.id;
      const message = update.callback_query.message;
      const chatId = message.chat.id;
      const messageId = message.message_id;

      // Only admins can operate callback buttons here
      if (!isAdmin(userId)) {
        await answerCallbackQuery(callbackQueryId, 'Unauthorized', true);
        return new Response('OK', { headers: corsHeaders });
      }

      // Handle admin menu buttons
      if (data === 'admin_create_order') {
        await startOrderCreation(chatId, userId);
        await answerCallbackQuery(callbackQueryId, 'Starting new order...');
        return new Response('OK', { headers: corsHeaders });
      }
      if (data === 'admin_active_orders') {
        await showActiveOrders(chatId);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }
      if (data === 'admin_connected_drivers') {
        await showConnectedDrivers(chatId);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }
      if (data === 'admin_recent_orders') {
        await showRecentOrders(chatId);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      // Handle order draft buttons and payment setting
      if (data.startsWith('edit_payment_')) {
        const orderNumber = data.split('_')[2];
        const order = activeOrders.get(orderNumber);
        if (!order || order.adminId !== userId) {
          await answerCallbackQuery(callbackQueryId, 'Order not found or permission denied.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        const keyboard = {
          inline_keyboard: [
            [{ text: 'Cash', callback_data: `set_payment_${orderNumber}_cash` }],
            [{ text: 'QR Code', callback_data: `set_payment_${orderNumber}_qrcode` }],
            [{ text: 'Paid', callback_data: `set_payment_${orderNumber}_paid` }],
            [{ text: '🔙 Back', callback_data: `back_order_${orderNumber}` }],
          ],
        };
        await editMessageText(chatId, messageId, `💳 <b>Select Payment Method for Order #${orderNumber}:</b>`, keyboard, true);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      if (data.startsWith('set_payment_')) {
        const parts = data.split('_');
        const orderNumber = parts[2];
        const payment = parts[3];
        const order = activeOrders.get(orderNumber);
        if (!order || order.adminId !== userId) {
          await answerCallbackQuery(callbackQueryId, 'Order not found or permission denied.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if (!Object.values(PAYMENT_TYPES).includes(payment)) {
          await answerCallbackQuery(callbackQueryId, 'Invalid payment method.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        order.payment = payment;
        order.waitingFor = null;
        // Stay on draft view after setting payment
        await updateOrderDisplay(chatId, messageId, orderNumber);
        await answerCallbackQuery(callbackQueryId, `Payment set to ${payment}`);
        return new Response('OK', { headers: corsHeaders });
      }

      if (data.startsWith('confirm_order_')) {
        // Show connected drivers for assignment
        const orderNumber = data.split('_')[2];
        const order = activeOrders.get(orderNumber);
        if (!order || order.adminId !== userId) {
          await answerCallbackQuery(callbackQueryId, 'Order not found or permission denied.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if (!order.customerId || !order.location) {
          await answerCallbackQuery(callbackQueryId, 'Please set Customer ID and Location first.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if (connectedDrivers.size === 0) {
          await editMessageText(chatId, messageId, `❌ <b>No drivers connected.</b> Please ask drivers to connect.`);
          await answerCallbackQuery(callbackQueryId);
          return new Response('OK', { headers: corsHeaders });
        }
        const driversArr = Array.from(connectedDrivers).map(driverId => [{ text: `🚗 Driver ${driverId}`, callback_data: `assign_driver_${orderNumber}_${driverId}` }]);
        driversArr.push([{ text: '🔙 Back to Edit', callback_data: `back_order_${orderNumber}` }]);
        const keyboard = { inline_keyboard: driversArr };
        const orderInfo = 
          `🚗 <b>Select Driver for Order #${orderNumber}:</b>\n\n` +
          `👤 Customer ID: <code>${order.customerId}</code>\n` +
          `📍 Location: ${escapeHTML(order.location)}\n` +
          `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
          `📝 Notes: ${escapeHTML(order.notes || '')}`;
        await editMessageText(chatId, messageId, orderInfo, keyboard, true);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      if (data.startsWith('back_order_')) {
        const orderNumber = data.split('_')[2];
        await updateOrderDisplay(chatId, messageId, orderNumber);
        await answerCallbackQuery(callbackQueryId, 'Back to order edit.');
        return new Response('OK', { headers: corsHeaders });
      }

      if (data.startsWith('assign_driver_')) {
        const parts = data.split('_');
        const orderNumber = parts[2];
        const driverId = parseInt(parts[3], 10);
        const order = activeOrders.get(orderNumber);
        if (!order || order.adminId !== userId) {
          await answerCallbackQuery(callbackQueryId, 'Order not found or permission denied.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if (!connectedDrivers.has(driverId)) {
          await answerCallbackQuery(callbackQueryId, 'Driver not connected.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        order.driverId = driverId;
        order.status = ORDER_STATUS.ASSIGNED;
        order.timestamps.assigned = new Date();

        const driverUser = { id: driverId, first_name: `Driver ${driverId}` };
        const customerUser = null;

        await sendOrderToDriver(driverId, orderNumber);

        const adminSummary =
          `✅ <b>Order #${orderNumber} Created and Assigned!</b>\n\n` +
          `👤 Customer: ${tgUserLink(customerUser)}\n` +
          `📍 Location: ${escapeHTML(order.location)}\n` +
          `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
          (order.notes ? `📝 Notes: ${escapeHTML(order.notes)}\n` : '') +
          `🚗 Driver: ${tgUserLink(driverUser)}\n\n` +
          `Order sent to driver.`;

        await editMessageText(chatId, messageId, adminSummary, null, true);

        activeOrders.delete(orderNumber);

        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      // Driver action buttons (pickup, notify, arrived, completed) from last full version:

      if (data.startsWith('pickup_')) {
        const orderNumber = data.split('_')[1];
        const order = Array.from(activeOrders.values()).find(o => o.orderNumber === orderNumber);
        if (!order) {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if (order.driverId !== userId) {
          await answerCallbackQuery(callbackQueryId, 'Only assigned driver can mark pickup.', true);
          return new Response('OK', { headers: corsHeaders });
        }

        order.status = ORDER_STATUS.PICKED_UP;
        order.timestamps.picked_up = new Date();

        await notifyAdmins(`📦 Order #${orderNumber} has been picked up by ${tgUserLink(update.callback_query.from)}`);
        await answerCallbackQuery(callbackQueryId, 'Pickup confirmed.');

        if (pickupTimers.has(orderNumber)) clearTimeout(pickupTimers.get(orderNumber));
        const timerId = setTimeout(async () => {
          await sendTelegramMessage(userId, '⚠️ Late delivery detected. Please notify customer if delay continues:\n"Traffic is busy; I will arrive shortly. Thanks for understanding."');
          pickupTimers.delete(orderNumber);
        }, 20 * 60 * 1000);
        pickupTimers.set(orderNumber, timerId);

        const text = renderOrderDetails(order, 'Order Picked Up', null, update.callback_query.from);
        await editMessageText(chatId, messageId, text, driverOrderButtons(orderNumber), true);

        return new Response('OK', { headers: corsHeaders });
      }

      if (data.startsWith('notify_')) {
        const orderNumber = data.split('_')[1];
        const order = Array.from(activeOrders.values()).find(o => o.orderNumber === orderNumber);
        if (!order) {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if (order.driverId !== userId) {
          await answerCallbackQuery(callbackQueryId, 'Only assigned driver can notify customer.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        const notifyText = `Hi, here's ${escapeHTML(update.callback_query.from.first_name)}, your meal is on the way and should be at your place within 20 minutes. See you soon!`;
        await sendTelegramMessage(userId, `Copy and send this message to the customer:\n\n${notifyText}`);
        await answerCallbackQuery(callbackQueryId, 'Notification text sent.');
        return new Response('OK', { headers: corsHeaders });
      }

      if (data.startsWith('arrived_')) {
        const orderNumber = data.split('_')[1];
        const order = Array.from(activeOrders.values()).find(o => o.orderNumber === orderNumber);
        if (!order) {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if (order.driverId !== userId) {
          await answerCallbackQuery(callbackQueryId, 'Only assigned driver can confirm arrival.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        order.status = ORDER_STATUS.ARRIVED;
        order.timestamps.arrived = new Date();

        await notifyAdmins(`${tgUserLink(update.callback_query.from)} has arrived for Order #${orderNumber}.\n"I'm arrived, thanks to come to pickup your meal."`);
        await answerCallbackQuery(callbackQueryId, 'Arrival confirmed.');
        return new Response('OK', { headers: corsHeaders });
      }

      if (data.startsWith('completed_')) {
        const orderNumber = data.split('_')[1];
        const order = Array.from(activeOrders.values()).find(o => o.orderNumber === orderNumber);
        if (!order) {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if (order.driverId !== userId) {
          await answerCallbackQuery(callbackQueryId, 'Only assigned driver can complete order.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        order.status = ORDER_STATUS.COMPLETED;
        order.timestamps.completed = new Date();

        await notifyAdmins(`📦 Order #${orderNumber} marked as completed by ${tgUserLink(update.callback_query.from)}`);

        const feedbackKeyboard = {
          inline_keyboard: [[1,2,3,4,5].map(star => ({ text: '⭐'.repeat(star), callback_data: `feedback_${orderNumber}_${star}` }))]
        };
        await sendTelegramMessage(userId, 'Thanks for ordering! Please rate your delivery experience:', feedbackKeyboard);

        activeOrders.delete(orderNumber);
        completedOrders.unshift(order);

        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      if(data.startsWith('feedback_')){
        const parts = data.split('_');
        const orderNumber = parts[1];
        const stars = parseInt(parts[2]);
        if(!stars || stars < 1 || stars > 5){
          await answerCallbackQuery(callbackQueryId, 'Invalid rating', true);
          return new Response('OK', { headers: corsHeaders });
        }
        await sendTelegramMessage(userId, `You rated delivery ${stars} star${stars>1?'s':''}. Please send feedback comments or type /skip to finish.`);
        feedbackSessions.set(userId, orderNumber);
        feedbackNotesWaiting.set(userId, orderNumber);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      // Unknown callback - just answer to prevent timeout
      await answerCallbackQuery(callbackQueryId);
      return new Response('OK', { headers: corsHeaders });
    }

    return new Response('OK', { headers: corsHeaders });
  } catch (e) {
    console.error('Error processing update:', e);
    return new Response('Internal Server Error', { status: 500, headers: corsHeaders });
  }
});

// Admin helper functions used in callback handler:
async function startOrderCreation(chatId, userId) {
  const orderNumber = generateOrderNumber();
  const orderData = {
    orderNumber,
    customerId: null,
    location: null,
    payment: PAYMENT_TYPES.PAID,
    notes: '',
    status: ORDER_STATUS.CREATED,
    driverId: null,
    adminId: userId,
    timestamps: { created: new Date() },
    waitingFor: null,
    editMessageId: null,
  };
  activeOrders.set(orderNumber, orderData);
  const keyboard = orderEditKeyboard(orderData);
  const text = renderOrderDetails(orderData, 'Creating Order');
  const sent = await sendTelegramMessage(chatId, text, keyboard, true);
  orderData.editMessageId = sent.result.message_id;
}
async function showActiveOrders(chatId) {
  if (activeOrders.size === 0) {
    await sendTelegramMessage(chatId, '📋 No active orders.');
    return;
  }
  let text = `<b>Active Orders (${activeOrders.size}):</b>\n\n`;
  for (const order of activeOrders.values()) {
    text += `📦 #${order.orderNumber} - <b>${order.status}</b>\n` +
      `👤 Customer ID: <code>${order.customerId}</code>\n` +
      `📍 Location: ${escapeHTML(order.location)}\n\n`;
  }
  await sendTelegramMessage(chatId, text);
}
async function showConnectedDrivers(chatId) {
  if (connectedDrivers.size === 0) {
    await sendTelegramMessage(chatId, '🚗 No drivers currently connected.');
    return;
  }
  const list = Array.from(connectedDrivers).map(id => `<a href="tg://user?id=${id}">Driver ${id}</a>`).join('\n');
  await sendTelegramMessage(chatId, `<b>Connected Drivers (${connectedDrivers.size}):</b>\n\n${list}`);
}
async function showRecentOrders(chatId) {
  if (completedOrders.length === 0) {
    await sendTelegramMessage(chatId, '📊 No recent completed orders.');
    return;
  }
  let text = '<b>Recent Completed Orders:</b>\n\n';
  for (const order of completedOrders.slice(0, 10)) {
    text += `📦 #${order.orderNumber} - Completed\n👤 Customer ID: <code>${order.customerId}</code>\n` +
      `⏰ ${order.timestamps.completed.toLocaleString()}\n\n`;
  }
  await sendTelegramMessage(chatId, text);
}
