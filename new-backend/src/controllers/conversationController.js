/* ── Colonel AI — conversation history (PER-USER PRIVATE) ───────────────────
   HARD RULE: every query is scoped to `where user_id = req.user.id`.
   A conversation is visible / editable / deletable ONLY by its owner. This is
   NOT relaxed for admins — an admin does NOT see other users' chats. So
   Dhaval's history is invisible to Anshul and vice-versa.                     */

const { Conversation } = require('../models/master');

const titleFrom = (messages) => {
  const firstUser = (messages || []).find((m) => m.role === 'user');
  const txt = (firstUser?.content || '').toString().trim().replace(/\s+/g, ' ');
  if (!txt) return 'New chat';
  return txt.length > 60 ? txt.slice(0, 57) + '…' : txt;
};

/* GET /api/conversations — only the caller's own, newest first (no messages). */
const listConversations = async (req, res, next) => {
  try {
    const rows = await Conversation.findAll({
      where: { user_id: req.user.id },
      attributes: ['id', 'title', 'model', 'createdAt', 'updatedAt'],
      order: [['updatedAt', 'DESC']],
    });
    res.json(rows);
  } catch (err) { next(err); }
};

/* GET /api/conversations/:id — 404 unless owned by the caller. */
const getConversation = async (req, res, next) => {
  try {
    const convo = await Conversation.findOne({
      where: { id: req.params.id, user_id: req.user.id },
    });
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    res.json(convo);
  } catch (err) { next(err); }
};

/* POST /api/conversations — always stamps user_id = caller. */
const createConversation = async (req, res, next) => {
  try {
    const { title, model, messages } = req.body || {};
    const convo = await Conversation.create({
      user_id: req.user.id,                            // owner — never from the body
      title: title || titleFrom(messages),
      model: model || 'claude-sonnet-4-6',
      messages: Array.isArray(messages) ? messages : [],
    });
    res.status(201).json(convo);
  } catch (err) { next(err); }
};

/* PATCH /api/conversations/:id — owner only; update title/model/messages. */
const updateConversation = async (req, res, next) => {
  try {
    const convo = await Conversation.findOne({
      where: { id: req.params.id, user_id: req.user.id },
    });
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    const patch = {};
    if (req.body?.title !== undefined) patch.title = req.body.title;
    if (req.body?.model !== undefined) patch.model = req.body.model;
    if (Array.isArray(req.body?.messages)) {
      patch.messages = req.body.messages;
      if (req.body?.title === undefined && convo.title === 'New chat') {
        patch.title = titleFrom(req.body.messages);
      }
    }
    await convo.update(patch);
    res.json(convo);
  } catch (err) { next(err); }
};

/* DELETE /api/conversations/:id — owner only. */
const deleteConversation = async (req, res, next) => {
  try {
    const n = await Conversation.destroy({
      where: { id: req.params.id, user_id: req.user.id },
    });
    if (!n) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ message: 'Conversation deleted' });
  } catch (err) { next(err); }
};

module.exports = {
  listConversations, getConversation, createConversation,
  updateConversation, deleteConversation,
};
