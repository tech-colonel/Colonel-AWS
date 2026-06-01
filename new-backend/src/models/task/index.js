const { DataTypes } = require('sequelize');
const { masterSequelize } = require('../../config/database');
const { User } = require('../master');

const Task = masterSequelize.define('Task', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  description: {
    type: DataTypes.TEXT,
  },
  status: {
    type: DataTypes.ENUM('pending', 'in_progress', 'done', 'overdue'),
    defaultValue: 'pending',
  },
  priority: {
    type: DataTypes.ENUM('low', 'medium', 'high', 'urgent'),
    defaultValue: 'medium',
  },
  due_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  assigned_to: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  assigned_by: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
}, {
  tableName: 'tasks',
  freezeTableName: true,
});

const TaskMessage = masterSequelize.define('TaskMessage', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  task_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'tasks', key: 'id' },
  },
  sender_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'users', key: 'id' },
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  sender_role: {
    type: DataTypes.ENUM('admin', 'accountant'),
    allowNull: false,
  },
}, {
  tableName: 'task_messages',
  freezeTableName: true,
});

// Associations
Task.belongsTo(User, { as: 'assignee', foreignKey: 'assigned_to' });
Task.belongsTo(User, { as: 'creator', foreignKey: 'assigned_by' });
Task.hasMany(TaskMessage, { as: 'messages', foreignKey: 'task_id', onDelete: 'CASCADE' });
TaskMessage.belongsTo(Task, { foreignKey: 'task_id' });
TaskMessage.belongsTo(User, { as: 'sender', foreignKey: 'sender_id' });

// Sync tables
const syncTaskTables = async () => {
  try {
    await Task.sync({ alter: true });
    await TaskMessage.sync({ alter: true });
    console.log('[Tasks] Tables synced');
  } catch (err) {
    console.error('[Tasks] Sync error:', err.message);
  }
};

module.exports = { Task, TaskMessage, syncTaskTables };
