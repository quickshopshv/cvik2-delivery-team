const TELEGRAM_BOT_TOKEN = '8300808943:AAEeQsBOOjQ4XhuNNWe40C5c86kIZFMvzZM';
const ADMIN_USER_IDS = [5186573916]; // Put your Telegram admin user IDs here

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const draftOrders = new Map();     // orderNumber -> draft order
const activeOrders = new Map();    // orderNumber -> assigned order
const completedOrders = [];        // completed orders list (most recent first)
const connectedDrivers = new Map(); // userId -> {id, first_name, username}

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

const pickupTimers = new Map();         // orderNumber -> timer handle
const feedbackSessions = new Map();     // driverId -> orderNumber
const feedbackNotesWaiting = new Map(); // driverId -> orderNumber

function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

function generateOrderNumber() {
  return String(orderCounter++).padStart(4, '0');
}

function escapeHTML(text) {
  if (!text) return '';
  return text.replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
}

function tgUserLink(user) {
  if (!user) return '<i>Unknown User</i>';
  if (user.username) return `<a href="https://t.me/${user.username}">${escapeHTML(user.first_name || 'User')}</a>`;
  return `<a href="tg://user?id=${user.id}">${escapeHTML(user.first_name || 'User')}</a>`;
}

async function sendTelegramMessage(chatId, text, replyMarkup = null, disableWebPagePreview = false) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: disableWebPagePreview,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
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
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: disableWebPagePreview,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: showAlert }),
  });
}

function renderOrderDetails(order, title = 'Order') {
  const customerLink = order.customerUser ? tgUserLink(order.customerUser) : `<code>${order.customerId}</code>`;
  const driverLink = order.driverUser ? tgUserLink(order.driverUser) : 'Not assigned';
  const notes = order.notes && order.notes.trim() ? escapeHTML(order.notes) : '';
  return `📦 <b>${title} #${order.orderNumber}</b>\n\n` +
         `👤 Customer: ${customerLink}\n` +
         `📍 Location: ${escapeHTML(order.location)}\n` +
         (notes ? `📝 Notes: ${notes}\n` : '') +
         `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
         `🚗 Driver: ${driverLink}`;
}

// Admin menus
function adminMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📝 Orders', callback_data: 'admin_orders_menu' }],
      [{ text: '🚗 Connected Drivers', callback_data: 'admin_connected_drivers' }],
    ],
  };
}

function ordersMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🗒️ Draft Orders', callback_data: 'admin_list_draft_orders' }],
      [{ text: '📋 Active Orders', callback_data: 'admin_list_active_orders' }],
      [{ text: '✅ Completed Orders', callback_data: 'admin_list_completed_orders' }],
      [{ text: '🔙 Back', callback_data: 'admin_main_menu' }],
    ],
  };
}

function draftOrderListKeyboard(drafts) {
  const rows = drafts.length ? drafts.map(o => ([
    { text: `✏️ Edit #${o.orderNumber}`, callback_data: `admin_edit_draft_${o.orderNumber}` },
    { text: `🗑️ Delete #${o.orderNumber}`, callback_data: `admin_delete_draft_${o.orderNumber}` },
  ])) : [[{ text: 'No draft orders', callback_data: 'noop' }]];
  rows.push([{ text: '🔙 Back', callback_data: 'admin_orders_menu' }]);
  return { inline_keyboard: rows };
}

function activeOrderListKeyboard(activeOrdersArray) {
  const rows = activeOrdersArray.length ? activeOrdersArray.map(o => ([{
    text: `#${o.orderNumber} - ${o.driverUser ? o.driverUser.first_name : 'Driver?'}`,
    callback_data: `admin_show_active_${o.orderNumber}`,
  }])) : [[{ text: 'No active orders', callback_data: 'noop' }]];
  rows.push([{ text: '🔙 Back', callback_data: 'admin_orders_menu' }]);
  return { inline_keyboard: rows };
}

function completedOrderListKeyboard(completedOrdersArray) {
  const rows = completedOrdersArray.length ? completedOrdersArray.map(o => ([{
    text: `#${o.orderNumber} - ${o.driverUser ? o.driverUser.first_name : 'Driver?'}`,
    callback_data: `admin_show_completed_${o.orderNumber}`,
  }])) : [[{ text: 'No completed orders', callback_data: 'noop' }]];
  rows.push([{ text: '🔙 Back', callback_data: 'admin_orders_menu' }]);
  return { inline_keyboard: rows };
}

function orderEditKeyboard(order) {
  return {
    inline_keyboard: [
      [{ text: '👤 Set Customer ID', callback_data: `edit_customer_${order.orderNumber}` }],
      [{ text: '📍 Set Location', callback_data: `edit_location_${order.orderNumber}` }],
      [{ text: `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}`, callback_data: `edit_payment_${order.orderNumber}` }],
      [{ text: '📝 Add Notes', callback_data: `edit_notes_${order.orderNumber}` }],
      [{ text: '✅ Create Order', callback_data: `confirm_order_${order.orderNumber}` }],
      [{ text: '🗑️ Delete Order', callback_data: `delete_order_${order.orderNumber}` }],
      [{ text: '🔙 Back', callback_data: 'admin_orders_menu' }],
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

async function updateOrderDisplay(chatId, messageId, orderNumber, isDraft = true) {
  const order = isDraft ? draftOrders.get(orderNumber) : activeOrders.get(orderNumber);
  if (!order) return;
  const text = renderOrderDetails(order, isDraft ? 'Order Draft' : 'Active Order');
  const keyboard = isDraft ? orderEditKeyboard(order) : null;
  await editMessageText(chatId, messageId, text, keyboard, true);
}

async function sendOrderToDriver(driverId, orderNumber) {
  const order = activeOrders.get(orderNumber);
  if (!order) return;
  const driverUser = connectedDrivers.get(driverId) || { id: driverId, first_name: `Driver ${driverId}` };
  const text = renderOrderDetails(order, 'New Delivery Order', order.customerUser, driverUser);
  await sendTelegramMessage(driverId, text, driverOrderButtons(orderNumber), true);
}

async function notifyAdmins(text) {
  for (const adminId of ADMIN_USER_IDS) {
    await sendTelegramMessage(adminId, text);
  }
}

async function showDraftOrders(chatId) {
  const drafts = Array.from(draftOrders.values());
  await sendTelegramMessage(chatId, `🗒️ <b>Draft Orders (${drafts.length}):</b>`, draftOrderListKeyboard(drafts));
}

async function showActiveOrders(chatId) {
  const actives = Array.from(activeOrders.values());
  await sendTelegramMessage(chatId, `📋 <b>Active Orders (${actives.length}):</b>`, activeOrderListKeyboard(actives));
}

async function showCompletedOrders(chatId) {
  const completedSlice = completedOrders.slice(0, 10);
  await sendTelegramMessage(chatId, `✅ <b>Completed Orders (Recent ${completedSlice.length}):</b>`, completedOrderListKeyboard(completedSlice));
}

async function showConnectedDrivers(chatId) {
  if (connectedDrivers.size === 0) {
    await sendTelegramMessage(chatId, '🚗 No drivers connected.');
    return;
  }
  const list = Array.from(connectedDrivers.values()).map(u => tgUserLink(u)).join('\n');
  await sendTelegramMessage(chatId, `<b>Connected Drivers (${connectedDrivers.size}):</b>\n\n${list}`);
}

async function startOrderCreation(chatId, userId) {
  const orderNumber = generateOrderNumber();
  const orderData = {
    orderNumber,
    customerId: null,
    customerUser: null,
    location: null,
    payment: PAYMENT_TYPES.PAID,
    notes: '',
    status: ORDER_STATUS.CREATED,
    driverId: null,
    driverUser: null,
    adminId: userId,
    timestamps: { created: new Date() },
    waitingFor: null,
    editMessageId: null,
  };
  draftOrders.set(orderNumber, orderData);
  const keyboard = orderEditKeyboard(orderData);
  const text = renderOrderDetails(orderData, 'Creating Order');
  const sent = await sendTelegramMessage(chatId, text, keyboard, true);
  orderData.editMessageId = sent.result.message_id;
}

Deno.serve(async (req) => {
  if(req.method === 'OPTIONS') return new Response(null, {headers: corsHeaders});
  if(req.method === 'GET') return new Response('Bot Running', {headers: corsHeaders});

  try {
    const update = await req.json();

    if(update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const textRaw = msg.text || '';
      const text = textRaw.trim();

      // Remove admins from connected drivers forcibly to avoid admin-driver conflicts
      for(const adminId of ADMIN_USER_IDS) {
        if(connectedDrivers.has(adminId)) connectedDrivers.delete(adminId);
      }

      // Driver commands in private chat, *only if NOT admin*
      if(chatId > 0 && !isAdmin(userId)) {
        const textLower = text.toLowerCase();

        if(textLower === '/connect') {
          if(connectedDrivers.has(userId)) {
            await sendTelegramMessage(chatId, '🚗 You are already connected.');
          } else {
            connectedDrivers.set(userId, { id: userId, first_name: msg.from.first_name, username: msg.from.username });
            await sendTelegramMessage(chatId, '✅ You are now connected.');
            await notifyAdmins(`🚗 Driver ${tgUserLink(msg.from)} connected.`);
          }
          return new Response('OK', { headers: corsHeaders });
        }
        if(textLower === '/disconnect') {
          if(!connectedDrivers.has(userId)) {
            await sendTelegramMessage(chatId, 'ℹ️ You were not connected.');
          } else {
            connectedDrivers.delete(userId);
            await sendTelegramMessage(chatId, '✅ You are now disconnected.');
            await notifyAdmins(`🚗 Driver ${tgUserLink(msg.from)} disconnected.`);
          }
          return new Response('OK', { headers: corsHeaders });
        }
        if(textLower === '/status') {
          await sendTelegramMessage(chatId, connectedDrivers.has(userId) ? '✅ You are connected.' : '❌ You are disconnected.');
          return new Response('OK', { headers: corsHeaders });
        }
      }

      // Admin commands & forwarding for new order creation
      if(isAdmin(userId)) {
        if(text.toLowerCase() === '/start') {
          await sendTelegramMessage(chatId, '👑 <b>Admin Panel</b>', adminMainMenuKeyboard());
          return new Response('OK', { headers: corsHeaders });
        }

        // Forwarded message creates a draft order
        if(msg.forward_from && msg.forward_from.id !== userId && chatId > 0) {
          const customerUser = msg.forward_from;
          const customerId = customerUser.id;
          const lines = text.split('\n');
          const location = lines[0].trim();
          const notes = lines.length > 1 ? lines.slice(1).join('\n').trim() : '';
          const orderNumber = generateOrderNumber();

          const newOrder = {
            orderNumber,
            customerId,
            customerUser,
            location,
            payment: PAYMENT_TYPES.PAID,
            notes,
            status: ORDER_STATUS.CREATED,
            driverId: null,
            driverUser: null,
            adminId: userId,
            timestamps: { created: new Date() },
            waitingFor: null,
            editMessageId: null,
          };

          draftOrders.set(orderNumber, newOrder);

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

        // Admin replies handling for editing draft orders
        for(const [orderNumber, order] of draftOrders.entries()) {
          if(order.adminId === userId && order.waitingFor) {
            switch(order.waitingFor) {
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
            await updateOrderDisplay(chatId, order.editMessageId, orderNumber, true);
            return new Response('OK', { headers: corsHeaders });
          }
        }
      }

      return new Response('OK', { headers: corsHeaders });
    } // end message handler

    // Callback query handler starts here
    if(update.callback_query) {
      const data = update.callback_query.data;
      const callbackQueryId = update.callback_query.id;
      const fromUser = update.callback_query.from;
      const userId = fromUser.id;
      const message = update.callback_query.message;
      const chatId = message.chat.id;
      const messageId = message.message_id;

      if(!isAdmin(userId)) {
        await answerCallbackQuery(callbackQueryId, 'Unauthorized', true);
        return new Response('OK', { headers: corsHeaders });
      }

      // Handle main menus & submenus
      if(data === 'admin_main_menu') {
        await sendTelegramMessage(chatId, '👑 <b>Admin Panel</b>', adminMainMenuKeyboard());
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }
      if(data === 'admin_orders_menu') {
        await sendTelegramMessage(chatId, '📝 <b>Orders Menu</b>', ordersMenuKeyboard());
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }
      if(data === 'admin_list_draft_orders') {
        await showDraftOrders(chatId);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }
      if(data === 'admin_list_active_orders') {
        await showActiveOrders(chatId);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }
      if(data === 'admin_list_completed_orders') {
        await showCompletedOrders(chatId);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }
      if(data === 'admin_connected_drivers') {
        await showConnectedDrivers(chatId);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      // Handle draft order edit/delete
      if(data.startsWith('admin_edit_draft_')) {
        const orderNumber = data.split('_')[3];
        const order = draftOrders.get(orderNumber);
        if(!order) {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
          return new Response('OK', { headers: corsHeaders });
        }
        const text = renderOrderDetails(order, 'Order Draft');
        const keyboard = orderEditKeyboard(order);
        await editMessageText(chatId, messageId, text, keyboard, true);
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      if(data.startsWith('admin_delete_draft_')) {
        const orderNumber = data.split('_')[3];
        if(draftOrders.delete(orderNumber)) {
          await answerCallbackQuery(callbackQueryId, 'Draft order deleted');
          await showDraftOrders(chatId);
        } else {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
        }
        return new Response('OK', { headers: corsHeaders });
      }

      // Editing draft order fields
      if(data.startsWith('edit_')) {
        const [_, field, orderNumber] = data.split('_');
        const order = draftOrders.get(orderNumber);
        if(!order) {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
          return new Response('OK', { headers: corsHeaders });
        }
        order.waitingFor = field;
        if(field === 'payment') {
          const keyboard = {
            inline_keyboard: [
              [{ text: 'Cash', callback_data: `set_payment_${orderNumber}_cash` }],
              [{ text: 'QR Code', callback_data: `set_payment_${orderNumber}_qrcode` }],
              [{ text: 'Paid', callback_data: `set_payment_${orderNumber}_paid` }],
              [{ text: '🔙 Back', callback_data: `back_order_${orderNumber}` }],
            ],
          };
          await editMessageText(chatId, messageId, `💳 <b>Select Payment for Order #${orderNumber}</b>:`, keyboard, true);
          await answerCallbackQuery(callbackQueryId);
          return new Response('OK', { headers: corsHeaders });
        }
        let prompt = '';
        switch(field) {
          case 'customer': prompt = '👤 Please enter the customer Telegram ID or username:'; break;
          case 'location': prompt = '📍 Please enter the location (address or map link):'; break;
          case 'notes': prompt = '📝 Please enter notes for this order:'; break;
          default: prompt = 'Please enter new value:';
        }
        await sendTelegramMessage(chatId, prompt);
        await answerCallbackQuery(callbackQueryId, `Please enter the new ${field}.`);
        return new Response('OK', { headers: corsHeaders });
      }

      // Set payment
      if(data.startsWith('set_payment_')) {
        const [, , orderNumber, payment] = data.split('_');
        const order = draftOrders.get(orderNumber);
        if(!order) {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if(!Object.values(PAYMENT_TYPES).includes(payment)) {
          await answerCallbackQuery(callbackQueryId, 'Invalid payment', true);
          return new Response('OK', { headers: corsHeaders });
        }
        order.payment = payment;
        order.waitingFor = null;
        await updateOrderDisplay(chatId, messageId, orderNumber, true);
        await answerCallbackQuery(callbackQueryId, `Payment set to ${payment}`);
        return new Response('OK', { headers: corsHeaders });
      }

      // Back to order edit
      if(data.startsWith('back_order_')) {
        const orderNumber = data.split('_')[2];
        await updateOrderDisplay(chatId, messageId, orderNumber, true);
        await answerCallbackQuery(callbackQueryId, 'Back to order edit.');
        return new Response('OK', { headers: corsHeaders });
      }

      // Confirm order: assign driver
      if(data.startsWith('confirm_order_')) {
        const orderNumber = data.split('_')[2];
        const order = draftOrders.get(orderNumber);
        if(!order) {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if(!order.customerId || !order.location) {
          await answerCallbackQuery(callbackQueryId, 'Please set Customer ID and Location first.', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if(connectedDrivers.size === 0) {
          await editMessageText(chatId, messageId, '❌ <b>No drivers connected. Please ask drivers to connect.</b>');
          await answerCallbackQuery(callbackQueryId);
          return new Response('OK', { headers: corsHeaders });
        }
        const driversArr = Array.from(connectedDrivers.values()).map(driver => ([
          { text: `🚗 ${tgUserLink(driver)}`, callback_data: `assign_driver_${orderNumber}_${driver.id}` }
        ]));
        driversArr.push([{ text: '🔙 Back to Edit', callback_data: `back_order_${orderNumber}` }]);
        await editMessageText(chatId, messageId,
          `🚗 <b>Select Driver for Order #${orderNumber}:</b>\n\n` +
          `👤 Customer ID: <code>${order.customerId}</code>\n` +
          `📍 Location: ${escapeHTML(order.location)}\n` +
          `💳 Payment: ${order.payment.charAt(0).toUpperCase() + order.payment.slice(1)}\n` +
          `📝 Notes: ${escapeHTML(order.notes || '')}`,
          { inline_keyboard: driversArr },
          true
        );
        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      // Assign driver and move order to active
      if(data.startsWith('assign_driver_')) {
        const parts = data.split('_');
        const orderNumber = parts[2];
        const driverId = parseInt(parts[3], 10);
        const order = draftOrders.get(orderNumber);
        if(!order) {
          await answerCallbackQuery(callbackQueryId, 'Order not found', true);
          return new Response('OK', { headers: corsHeaders });
        }
        if(!connectedDrivers.has(driverId)) {
          await answerCallbackQuery(callbackQueryId, 'Driver not connected', true);
          return new Response('OK', { headers: corsHeaders });
        }
        order.driverId = driverId;
        order.driverUser = connectedDrivers.get(driverId);
        order.status = ORDER_STATUS.ASSIGNED;
        order.timestamps.assigned = new Date();

        draftOrders.delete(orderNumber);
        activeOrders.set(orderNumber, order);

        await sendOrderToDriver(driverId, orderNumber);

        await editMessageText(chatId, messageId,
          `✅ <b>Order #${orderNumber} Created and Assigned!</b>\n\n${renderOrderDetails(order)}`,
          null,
          true
        );

        await answerCallbackQuery(callbackQueryId);
        return new Response('OK', { headers: corsHeaders });
      }

      // Delete draft order
      if(data.startsWith('delete_order_')) {
        const orderNumber = data.split('_')[2];
        if(draftOrders.delete(orderNumber)) {
          await answerCallbackQuery(callbackQueryId, 'Draft order deleted.');
          await showDraftOrders(chatId);
        } else {
          await answerCallbackQuery(callbackQueryId, 'Order not found.', true);
        }
        return new Response('OK', { headers: corsHeaders });
      }

      // Add your driver buttons handling (pickup, notify, arrived, completed, feedback)
      // according to your previous working implementations.

      // Always answer callback queries to prevent Telegram UI hangups
      await answerCallbackQuery(callbackQueryId);
      return new Response('OK', { headers: corsHeaders });
    }

    return new Response('OK', { headers: corsHeaders });
  } catch(err) {
    console.error('Webhook error:', err);
    return new Response('Internal Server Error', { status: 500, headers: corsHeaders });
  }
});
