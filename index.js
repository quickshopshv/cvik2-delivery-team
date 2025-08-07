// Full Delivery Bot with fixed draft message payment display and button callback handling
// Run with Deno

const TELEGRAM_BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE';
const ADMIN_USER_IDS = [5186573916]; // Your admin Telegram user IDs

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const activeOrders = new Map();
const completedOrders = [];
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

const pickupTimers = new Map();
const feedbackSessions = new Map();
const feedbackNotesWaiting = new Map();
const notifyMessages = new Map();

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function generateOrderNumber() {
  return String(orderCounter++).padStart(4, '0');
}

function escapeHTML(text) {
  if (!text) return '';
  return text.replace(/&/g, "&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function tgUserLink(user) {
  if (!user) return '<i>Unknown User</i>';
  if (user.username) return `<a href="https://t.me/${user.username}">${escapeHTML(user.first_name || 'User')}</a>`;
  return `<a href="tg://user?id=${user.id}">${escapeHTML(user.first_name || 'User')}</a>`;
}

async function sendTelegramMessage(chatId, text, replyMarkup = null, disableWebPagePreview = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: disableWebPagePreview };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) console.error('Telegram sendMessage error:', await resp.text());
  return resp.json();
}

async function editMessageText(chatId, messageId, text, replyMarkup = null, disableWebPagePreview = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: disableWebPagePreview };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return resp.json();
}

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert }) });
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

// Driver order buttons for driver message
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

// Update the draft order display message (to stay on draft view after payment set)
async function updateOrderDisplay(chatId, messageId, orderNumber) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  const text = renderOrderDetails(order, 'Order Draft');
  const keyboard = orderEditKeyboard(order);
  await editMessageText(chatId, messageId, text, keyboard, true);
}

// Send new delivery order message to driver (fixed to match admin order summary exactly)
async function sendOrderToDriver(driverId, orderNumber) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  const customerUser = null;
  const driverUser = { id: driverId, first_name: `Driver ${driverId}` };
  const text = renderOrderDetails(order, 'New Delivery Order', customerUser, driverUser);
  await sendTelegramMessage(driverId, text, driverOrderButtons(orderNumber), true);
}

async function notifyAdmins(text) {
  for (const adminId of ADMIN_USER_IDS) {
    await sendTelegramMessage(adminId, text);
  }
}

// Your timer and feedback code omitted here for brevity, keep as is

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method === 'GET') return new Response('Bot Running', { headers: corsHeaders });

  try {
    const update = await req.json();

    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const textRaw = msg.text || '';
      const text = textRaw.trim();

      // Driver connect/disconnect/status commands here - as before, omitted for brevity

      // Admin commands
      if (isAdmin(userId)) {
        if (text.toLowerCase() === '/start') {
          await sendTelegramMessage(chatId, '👑 <b>Admin Panel</b>', adminMainMenuKeyboard());
          return new Response('OK', { headers: corsHeaders });
        }

        // Forwarded customer message creates new order draft
        if (
          msg.forward_from &&
          msg.forward_from.id !== userId &&
          chatId > 0
        ) {
          const customerUser = msg.forward_from;
          const customerId = customerUser.id;

          const lines = text.split('\n');
          let location = lines[0].trim();
          let notes = '';
          if (lines.length > 1) notes = lines.slice(1).join('\n').trim();

          const orderNumber = generateOrderNumber();
          const newOrder = {
            orderNumber,
            customerId,
            location,
            payment: PAYMENT_TYPES.PAID,   // Default payment now "paid"
            notes,
            status: ORDER_STATUS.CREATED,
            driverId: null,
            adminId: userId,
            timestamps: { created: new Date() },
            waitingFor: null,
            editMessageId: null,
          };

          activeOrders.set(orderNumber, newOrder);

          // FIXED: Display payment in text properly
          const orderText =
            `📦 <b>New Order Draft #${orderNumber}</b>\n\n` +
            `👤 Customer: ${tgUserLink(customerUser)}\n` +
            `📍 Location: ${escapeHTML(location)}\n` +
            (notes ? `📝 Notes: ${escapeHTML(notes)}\n` : '') +
            `💳 Payment: Paid\n` + // Added explicitly to ensure visible on initial draft
            `<b>Choose an action:</b>`;

          // FIXED: Buttons callback_data exactly matching callback handler
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

        // Admin text replies to waitingFor inputs handled here - omitted for brevity
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

      if (!isAdmin(userId)) {
        await answerCallbackQuery(callbackQueryId, 'Unauthorized', true);
        return new Response('OK', { headers: corsHeaders });
      }

      // FIXED: Callback handler for payment edit button
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

      // Payment selection sets payment but stays on draft (no jump)
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
        await updateOrderDisplay(chatId, messageId, orderNumber);
        await answerCallbackQuery(callbackQueryId, `Payment set to ${payment}`);
        return new Response('OK', { headers: corsHeaders });
      }

      // Confirm order button shows driver selection keyboard
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
            callback_data: `assign_driver_${orderNumber}_${driverId}`,
          }]).concat([[{ text: '🔙 Back to Edit', callback_data: `back_order_${orderNumber}` }]]),
        };
        const text =
          `🚗 <b>Select Driver for Order #${orderNumber}:</b>\n\n` +
          `👤 Customer ID: <code>${order.customerId}</code>\n` +
          `📍 Location: ${escapeHTML(order.location)}\n` +
          `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
          `📝 Notes: ${escapeHTML(order.notes || '')}`;
        await editMessageText(chatId, messageId, text, keyboard, true);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      // Back to order draft edit message
      if (data.startsWith('back_order_')) {
        const orderNumber = data.split('_')[2];
        await updateOrderDisplay(chatId, messageId, orderNumber);
        await answerCallbackQuery(callbackQueryId, 'Back to order edit.');
        return new Response('OK', { headers: corsHeaders });
      }

      // Assign driver button
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

        const customerUser = null; // Placeholder for user caching
        const driverUser = { id: driverId, first_name: `Driver ${driverId}` };

        // Send order to driver with action buttons
        await sendOrderToDriver(driverId, orderNumber);

        // Notify admin with enriched info
        const adminText =
          `✅ <b>Order #${orderNumber} Created and Assigned!</b>\n\n` +
          `👤 Customer: ${tgUserLink(customerUser)}\n` +
          `📍 Location: ${escapeHTML(order.location)}\n` +
          `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
          (order.notes ? `📝 Notes: ${escapeHTML(order.notes)}\n` : '') +
          `🚗 Driver: ${tgUserLink(driverUser)}\n\n` +
          `Order sent to driver.`;

        await editMessageText(chatId, messageId, adminText, null, true);
        await answerCallbackQuery(callbackQueryId);
        activeOrders.delete(orderNumber);
        return new Response('OK', { headers: corsHeaders });
      }

      // ... Additional callbacks for pickup, notify, arrived, completed, feedback ... (keep as before)

      // Default callback answer
      await answerCallbackQuery(callbackQueryId);
      return new Response('OK', { headers: corsHeaders });
    }

    return new Response('OK', { headers: corsHeaders });
  } catch (error) {
    console.error('Error in webhook:', error);
    return new Response('Internal Server Error', { status: 500, headers: corsHeaders });
  }
});
