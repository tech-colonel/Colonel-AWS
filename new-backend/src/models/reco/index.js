const { DataTypes } = require('sequelize');

/**
 * Get or define the reco_jobs model on a brand sequelize connection.
 */
const getRecoJobModel = (sequelize) => {
  if (sequelize.models.reco_jobs) return sequelize.models.reco_jobs;
  return sequelize.define('reco_jobs', {
    id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    brand_id:       { type: DataTypes.UUID, allowNull: false },
    agent_type:     { type: DataTypes.STRING(50), allowNull: false },
    month:          { type: DataTypes.INTEGER },
    year:           { type: DataTypes.INTEGER },
    file_hash:      { type: DataTypes.STRING(64) },
    status:         { type: DataTypes.STRING(20), defaultValue: 'completed' },
    total_rows:     { type: DataTypes.INTEGER, defaultValue: 0 },
    matched_rows:   { type: DataTypes.INTEGER, defaultValue: 0 },
    unmatched_rows: { type: DataTypes.INTEGER, defaultValue: 0 },
    output_file_id: { type: DataTypes.STRING(36) },
    created_by:     { type: DataTypes.UUID },
  }, { tableName: 'reco_jobs', timestamps: true, underscored: true });
};

const getBankRecoResultModel = (sequelize) => {
  if (sequelize.models.bank_reco_results) return sequelize.models.bank_reco_results;
  return sequelize.define('bank_reco_results', {
    id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    job_id:      { type: DataTypes.UUID, allowNull: false },
    brand_id:    { type: DataTypes.UUID, allowNull: false },
    txn_date:    { type: DataTypes.DATEONLY },
    description: { type: DataTypes.TEXT },
    debit:       { type: DataTypes.DECIMAL(15, 2) },
    credit:      { type: DataTypes.DECIMAL(15, 2) },
    balance:     { type: DataTypes.DECIMAL(15, 2) },
    txn_type:    { type: DataTypes.STRING(50) },
    ledger_name: { type: DataTypes.STRING(255) },
    confidence:  { type: DataTypes.STRING(20) },
  }, { tableName: 'bank_reco_results', timestamps: true, underscored: true });
};

const getGstr2bResultModel = (sequelize) => {
  if (sequelize.models.gstr_2b_results) return sequelize.models.gstr_2b_results;
  return sequelize.define('gstr_2b_results', {
    id:              { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    job_id:          { type: DataTypes.UUID, allowNull: false },
    brand_id:        { type: DataTypes.UUID, allowNull: false },
    supplier_name:   { type: DataTypes.STRING(255) },
    supplier_gstin:  { type: DataTypes.STRING(20) },
    invoice_number:  { type: DataTypes.STRING(100) },
    invoice_date:    { type: DataTypes.DATEONLY },
    taxable_value:   { type: DataTypes.DECIMAL(15, 2) },
    igst:            { type: DataTypes.DECIMAL(15, 2) },
    cgst:            { type: DataTypes.DECIMAL(15, 2) },
    sgst:            { type: DataTypes.DECIMAL(15, 2) },
    remark_1:        { type: DataTypes.STRING(100) },
    remark_2:        { type: DataTypes.TEXT },
  }, { tableName: 'gstr_2b_results', timestamps: true, underscored: true });
};

module.exports = { getRecoJobModel, getBankRecoResultModel, getGstr2bResultModel };
