// Database-Free Delivery Bot with Forwarded Message New Order Creation
// Run with Deno

const TELEGRAM_BOT_TOKEN = '8300808943:AAEeQsBOOjQ4XhuNNWe40C5c86kIZFMvzZM';
const DRIVER_GROUP_ID = -2734011708; // Replace with your drivers group chat ID
const ADMIN_USER_IDS = [5186573916]; // Admin Telegram user IDs

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

// In-memory stores
const activeOrders = new Map(); // orderNumber -> order data
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

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    console.error('Telegram sendMessage error:', await resp.text());
  }
  return resp.json();
}

async function editMessageText(chatId, messageId, text, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return resp.json();
}

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert })
  });
}

function renderOrderDetails(order, title = 'Order') {
  return `📦 <b>${title} #${order.orderNumber}</b>\n\n` +
    `👤 Customer ID: <code>${order.customerId}</code>\n` +
    `📍 Location: ${order.location}\n` +
    `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
    `📝 Notes: ${order.notes || '<i>None</i>'}`;
}

function orderEditKeyboard(order) {
  // Used if you want to include editing buttons later (optional)
  return {
    inline_keyboard: [
      [{ text: '💳 Set Payment', callback_data: `edit_payment_${order.orderNumber}` }],
      [{ text: '✅ Create Order', callback_data: `confirm_order_${order.orderNumber}` }]
    ]
  };
}

async function updateOrderDisplay(chatId, messageId, orderNumber) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  const text = renderOrderDetails(order, 'Order Draft');
  const keyboard = orderEditKeyboard(order);
  await editMessageText(chatId, messageId, text, keyboard);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method === 'GET') {
    return new Response('Database-Free Delivery Bot is running!', { headers: corsHeaders });
  }

  if (req.method === 'POST') {
    try {
      const update = await req.json();

      // Handle forwarded messages from admin with forwarded customer data
      if (update.message) {
        const { message } = update;
        const chatId = message.chat.id;
        const userId = message.from.id;
        const text = message.text || '';

        // === Forward message handling (new orders from forwarded customer messages) ===
        if (
          isAdmin(userId) &&
          message.forward_from &&
          chatId > 0 &&
          message.forward_from.id !== userId
        ) {
          // Extract info from forward
          const customerId = message.forward_from.id;
          const locationText = text.trim();

          // Parse notes if multiple lines (first line = location)
          const lines = locationText.split('\n');
          let location = lines[0];
          let notes = '';
          if (lines.length > 1) {
            notes = lines.slice(1).join('\n').trim();
          }

          // Create new order draft
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

          const orderText =
            `📦 <b>New Order Draft #${orderNumber}</b>\n\n` +
            `👤 Customer ID: <code>${customerId}</code>\n` +
            `📍 Location: ${location}\n` +
            `📝 Notes: ${notes || '<i>None</i>'}\n\n` +
            `<b>Choose an action:</b>`;

          const keyboard = {
            inline_keyboard: [
              [{ text: '💳 Set Payment', callback_data: `edit_payment_${orderNumber}` }],
              [{ text: '✅ Create Order', callback_data: `confirm_order_${orderNumber}` }]
            ]
          };

          const sent = await sendTelegramMessage(chatId, orderText, keyboard);
          newOrder.editMessageId = sent.result.message_id;

          return new Response('OK', { headers: corsHeaders });
        }

        // ... You can add other message handling logic here (like admin waitingFor input) ...

        return new Response('OK', { headers: corsHeaders });
      }

      // === Handle callback queries from inline buttons ===
      if (update.callback_query) {
        const data = update.callback_query.data;
        const callbackQueryId = update.callback_query.id;
        const userId = update.callback_query.from.id;
        const message = update.callback_query.message;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        if (!isAdmin(userId)) {
          await answerCallbackQuery(callbackQueryId, 'Unauthorized', true);
          return new Response('OK', { headers: corsHeaders });
        }

        // Handle Set Payment button: show payment options
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
          await editMessageText(chatId, messageId, `💳 <b>Select Payment Method for Order #${orderNumber}:</b>`, keyboard);
          await answerCallbackQuery(callbackQueryId);
          return new Response('OK', { headers: corsHeaders });
        }

        // Handle selecting payment method
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
          await updateOrderDisplay(chatId, messageId, orderNumber);
          await answerCallbackQuery(callbackQueryId, `Payment set to ${payment}`);
          return new Response('OK', { headers: corsHeaders });
        }

        // Go back to main order edit message
        if (data.startsWith('back_order_')) {
          const orderNumber = data.split('_')[2];
          await updateOrderDisplay(chatId, messageId, orderNumber);
          await answerCallbackQuery(callbackQueryId, 'Back to order edit.');
          return new Response('OK', { headers: corsHeaders });
        }

        // Create order -> show connected drivers to assign
        if (data.startsWith('confirm_order_')) {
          const orderNumber = data.split('_')[2];
          const order = activeOrders.get(orderNumber);
          if (!order || order.adminId !== userId) {
            await answerCallbackQuery(callbackQueryId, 'Order not found or permission denied.', true);
            return new Response('OK', { headers: corsHeaders });
          }
          if (!order.customerId || !order.location) {
            await answerCallbackQuery(callbackQueryId, 'Customer ID and Location are required.', true);
            return new Response('OK', { headers: corsHeaders });
          }
          if (connectedDrivers.size === 0) {
            await editMessageText(chatId, messageId, `❌ <b>No drivers connected currently.</b> Please ask drivers to connect.`);
            await answerCallbackQuery(callbackQueryId);
            return new Response('OK', { headers: corsHeaders });
          }

          const keyboard = {
            inline_keyboard: Array.from(connectedDrivers).map(driverId => [{
              text: `🚗 Driver ${driverId}`,
              callback_data: `assign_driver_${orderNumber}_${driverId}`
            }]).concat([[{ text: '🔙 Back to Edit', callback_data: `back_order_${orderNumber}` }]])
          };

          const text =
            `🚗 <b>Select Driver for Order #${orderNumber}:</b>\n\n` +
            `👤 Customer: <code>${order.customerId}</code>\n` +
            `📍 Location: ${order.location}\n` +
            `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
            `📝 Notes: ${order.notes || 'None'}`;

          await editMessageText(chatId, messageId, text, keyboard);
          await answerCallbackQuery(callbackQueryId);
          return new Response('OK', { headers: corsHeaders });
        }

        // Assign selected driver, finalize order
        if (data.startsWith('assign_driver_')) {
          const parts = data.split('_');
          const orderNumber = parts[2];
          const driverId = parseInt(parts[3]);
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

          // Notify driver
          const driverMsg =
            `🚗 <b>New Delivery Order #${orderNumber}</b>\n\n` +
            `📍 Location: ${order.location}\n` +
            `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
            `📝 Notes: ${order.notes || 'None'}\n\n` +
            `Please proceed with the delivery.`;

          await sendTelegramMessage(driverId, driverMsg);

          // Update admin message
          await editMessageText(chatId, messageId,
            `✅ <b>Order #${orderNumber} Created and Assigned!</b>\n\n` +
            `👤 Customer: <code>${order.customerId}</code>\n` +
            `📍 Location: ${order.location}\n` +
            `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
            `📝 Notes: ${order.notes || 'None'}\n` +
            `🚗 Driver: ${driverId}\n\n` +
            `Order sent to driver.`);

          // Optional: notify customer about order creation with tracking (if username or other means available)

          // Remove from activeOrders if you want to mark it done here
          activeOrders.delete(orderNumber);

          await answerCallbackQuery(callbackQueryId);
          return new Response('OK', { headers: corsHeaders });
        }

        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      return new Response('OK', { headers: corsHeaders });
    } catch (e) {
      console.error('Error handling update:', e);
      return new Response('Error', { status: 500, headers: corsHeaders });
    }
  }

  return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
});
