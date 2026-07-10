const XLSX = require('xlsx');
const { Brand, Agent } = require('../../../models/master');
const { getBrandConnection } = require('../../../config/database');
const { getDynamicModel } = require('../../../models/brand');
const { setPending, getPending, deletePending } = require('../../../services/pendingGenerationsStore');
const { v4: uuidv4 } = require('uuid');

/**
 * Get Master Data - stubbed for compatibility
 */
const getMasterData = async (req, res, next) => {
    try {
        res.json({ skus: [], ledgers: [] });
    } catch (error) {
        next(error);
    }
};

/**
 * Upload SKU Master - stubbed for compatibility
 */
const uploadSkuMaster = async (req, res, next) => {
    try {
        res.json({ message: 'SKU Master upload not required for this agent.' });
    } catch (error) {
        next(error);
    }
};

/**
 * Upload Ledger Master - stubbed for compatibility
 */
const uploadLedgerMaster = async (req, res, next) => {
    try {
        res.json({ message: 'Ledger Master upload not required for this agent.' });
    } catch (error) {
        next(error);
    }
};

/**
 * Parse Total Sales Excel
 * Parses the ledger-style Tally export where:
 * Parent Row has: Date | Particulars (Party Name) | Vch Type | Vch No. | Gross Total
 * Child Row has: (Empty Date) | Particulars (SKU) | Quantity | Value
 */

const generatePreview = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ error: 'File is required' });
        }

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const workbook = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        const rawData = XLSX.utils.sheet_to_json(sheet, { defval: null });

        const parsedData = [];
        let currentDate = null;
        let currentBuyerSupplier = null;
        let currentVchType = null;
        let currentVchNo = null;
        let currentGrossTotal = null;
        let currentBuyerSupplierAddress = null;
        let currentCity = null;
        let currentState = null;
        let currentDepoName = null;

        const getVal = (row, possibleNames) => {
            for (const key of Object.keys(row)) {
                const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
                for (const name of possibleNames) {
                    if (normKey === name) return row[key];
                }
            }
            return null;
        };

        for (let i = 0; i < rawData.length; i++) {
            const row = rawData[i];

            const accountVal = getVal(row, ['account']);
            const dateVal = getVal(row, ['date']);
            const particularsVal = getVal(row, ['particulars', 'particular', 'partyname', 'party']);
            const itemNameVal = getVal(row, ['itemname', 'nameofitem', 'item', 'stockitem', 'sku', 'product', 'description']);
            const vchTypeVal = getVal(row, ['vchtype', 'vouchertype']);
            const vchNoVal = getVal(row, ['vchno', 'voucherno']);
            const quantityVal = getVal(row, ['quantity', 'qty', 'billedqty']);
            const valueVal = getVal(row, ['value', 'amount']);
            const grossTotalVal = getVal(row, ['grosstotal', 'total']);
            const buyerSupplierAddressVal = getVal(row, ['buyer_supplier_address', 'address', 'buyersupplieraddress']);
            const cityVal = getVal(row, ['city']);
            const stateVal = getVal(row, ['state']);
            const depoNameVal = getVal(row, ['depo', 'deponame']);
            // "Sales Value" is a child-row column (per-SKU sale amount), distinct from "Value" (taxable amount)
            // The Excel column "Sales Value" normalizes to 'salesvalue' after stripping spaces
            const salesValueVal = getVal(row, ['salesvalue', 'salesamount', 'salesval', 'salevalue', 'salesamt']);

            const hasVchNo = vchNoVal !== null && String(vchNoVal).trim() !== '';
            const hasGrossTotal = grossTotalVal !== null && String(grossTotalVal).trim() !== '';

            // 1. Maintain Parent Context
            if (dateVal) currentDate = dateVal;
            if (vchTypeVal) currentVchType = vchTypeVal;
            if (hasVchNo) currentVchNo = vchNoVal;
            if (hasGrossTotal) currentGrossTotal = valueVal || grossTotalVal;

            // 2. Determine if this row is a Parent Summary Row
            let isParentSummary = false;

            if (hasGrossTotal) {
                // Tally usually puts Gross Total only on the parent row
                isParentSummary = true;
            } else if (hasVchNo) {
                // If it has a VchNo, check if the next row is a child (no VchNo)
                let nextRowHasNoVch = false;
                if (i + 1 < rawData.length) {
                    const nextVch = getVal(rawData[i + 1], ['vchno', 'voucherno']);
                    if (!nextVch || String(nextVch).trim() === '') {
                        // Check if next row has quantity or value to confirm it's an item row
                        const nextQty = getVal(rawData[i + 1], ['quantity', 'qty', 'billedqty']);
                        const nextVal = getVal(rawData[i + 1], ['value', 'amount']);
                        if (nextQty !== null || nextVal !== null) {
                            nextRowHasNoVch = true;
                        }
                    }
                }
                if (nextRowHasNoVch) {
                    isParentSummary = true;
                }
            } else if (dateVal && !quantityVal && !valueVal && !hasVchNo && !hasGrossTotal) {
                // Classic parent row with Date but no items and no VchNo
                isParentSummary = true;
            }

            // 3. Update Buyer Supplier from Parent
            if (isParentSummary) {
                currentBuyerSupplier = particularsVal;
                if (buyerSupplierAddressVal) currentBuyerSupplierAddress = buyerSupplierAddressVal;
                if (cityVal) currentCity = cityVal;
                if (stateVal) currentState = stateVal;
                if (depoNameVal) currentDepoName = depoNameVal;
                continue; // Skip adding the parent row as an SKU item
            }

            // 4. If we reach here, it's a child row (or a flat item row)
            // It must have some quantity or value to be valid
            if (quantityVal === null && valueVal === null) {
                continue;
            }

            // Filter out tax/total lines
            const lowerParticulars = String(particularsVal || '').toLowerCase();
            if (lowerParticulars.includes('total') || lowerParticulars.includes('balance') ||
                lowerParticulars.match(/cgst|sgst|igst/)) {
                continue;
            }

            // 5. Determine SKU and Buyer
            let sku = particularsVal;
            let buyer = currentBuyerSupplier;

            if (itemNameVal) {
                sku = itemNameVal;
                // If it's a flat file, buyer might be in particulars
                if (particularsVal && particularsVal !== itemNameVal) {
                    buyer = particularsVal;
                }
            }

            // Prepare Date
            let parsedDate = currentDate;
            if (typeof currentDate === 'string') {
                const parts = currentDate.split(/[-/]/);
                if (parts.length === 3) {
                    // Assuming MM/DD/YYYY as per original logic
                    const m = parseInt(parts[0], 10) - 1;
                    const d = parseInt(parts[1], 10);
                    let y = parseInt(parts[2], 10);
                    if (y < 100) y += 2000;
                    parsedDate = new Date(y, m, d);
                } else {
                    parsedDate = new Date(currentDate);
                }
            }

            const finalDate = parsedDate instanceof Date && !isNaN(parsedDate) ? parsedDate : null;

            parsedData.push({
                id: uuidv4(),
                filename: file.originalname,
                account: accountVal || 'Unknown',
                date: finalDate,
                year: finalDate ? finalDate.getFullYear() : null,
                month: finalDate ? finalDate.getMonth() + 1 : null,
                particulars: buyer,
                SKU: sku,
                buyer_supplier: buyer,
                buyer_supplier_address: buyerSupplierAddressVal || currentBuyerSupplierAddress,
                city: cityVal || currentCity,
                state: stateVal || currentState,
                depo_name: depoNameVal || currentDepoName,
                voucher_type: currentVchType,
                voucher_no: String(currentVchNo || ''),
                quantity: String(quantityVal || ''),
                value: valueVal ? parseFloat(valueVal) : null,
                gross_total: currentGrossTotal ? parseFloat(currentGrossTotal) : null,
                // "Sales Value" read directly from child row — separate column from "Value"
                sales_value: salesValueVal !== null ? parseFloat(salesValueVal) : null,
                created_at: new Date()
            });
        }

        const taskId = uuidv4();

        setPending(taskId, {
            finalData: parsedData,
            summary: {
                totalRows: rawData.length,
                processedRows: parsedData.length
            }
        });

        res.json({
            taskId,
            message: 'Preview generated successfully',
            previewData: parsedData.slice(0, 100),
            rowCount: parsedData.length
        });

    } catch (error) {
        console.error('Total Sales Preview Error:', error);
        next(error);
    }
};

const generateCommit = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { taskId } = req.body;

        if (!taskId) return res.status(400).json({ error: 'taskId required' });

        const pending = getPending(taskId);
        if (!pending) return res.status(404).json({ error: 'Task expired or not found' });

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        await brandDb.transaction(async (t) => {
            await Model.bulkCreate(pending.finalData, { transaction: t });
        });

        deletePending(taskId);

        res.json({
            message: 'Data saved successfully',
            recordsInserted: pending.finalData.length
        });
    } catch (error) {
        console.error('Total Sales Commit Error:', error);
        next(error);
    }
};

const generateDiscard = async (req, res, next) => {
    try {
        const { taskId } = req.body;
        if (!taskId) return res.status(400).json({ error: 'taskId required' });

        deletePending(taskId);
        res.json({ message: 'Task discarded' });
    } catch (error) {
        console.error('Total Sales Discard Error:', error);
        next(error);
    }
};

const getDashboardData = async (req, res, next) => {
    try {
        const { brandId, agentId } = req.params;
        const { year, startMonth, endMonth } = req.body;

        const brand = await Brand.findByPk(brandId);
        const agent = await Agent.findByPk(agentId);

        if (!brand || !agent) {
            return res.status(404).json({ error: 'Brand or Agent not found' });
        }

        const brandDb = getBrandConnection(brand.db_name);
        const tableName = agent.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const Model = getDynamicModel(brandDb, tableName, agent.columns);

        const whereClause = {};
        const { Op } = require('sequelize');

        if (year) {
            const numericYear = parseInt(year);
            whereClause[Op.or] = [
                { year: numericYear, month: { [Op.gte]: 4 } },
                { year: numericYear + 1, month: { [Op.lte]: 3 } }
            ];
        }
        if (startMonth && endMonth) {
            const sMonth = parseInt(startMonth);
            const eMonth = parseInt(endMonth);
            if (!isNaN(sMonth) && !isNaN(eMonth)) {
                whereClause.month = {
                    ...whereClause.month,
                    [Op.between]: [Math.min(sMonth, eMonth), Math.max(sMonth, eMonth)]
                };
            }
        }

        const rawData = await Model.findAll({
            where: whereClause,
            raw: true
        });

        // --- Pre-filter: exclude unwanted account types before any calculation ---
        const EXCLUDED_ACCOUNTS = ['BRANCH SALES', 'RATE DIFF BRANCH @12%'];
        const data = rawData.filter(row => {
            const account = String(row.account || '').trim().toUpperCase();
            return !EXCLUDED_ACCOUNTS.includes(account);
        });

        const skuMonthData = {};
        const locationData = {};
        const buyerData = {};
        const locationStateBuyers = {};
        const buyerDetails = {};
        const allSkus = new Set();

        data.forEach(row => {
            const sku = row.SKU || 'Unknown';
            const monthStr = row.month || 'Unknown';
            const state = row.state || 'Unknown';
            const city = row.city || 'Unknown';
            const buyer = row.buyer_supplier || row.particulars || 'Unknown';

            // SKU Performance uses the "value" column (item-level invoice value)
            const skuValue = parseFloat(row.value) || 0;
            const quantity = parseFloat(row.quantity) || 0;

            // Location & Buyer use the "sales_value" column; fall back to "value" if missing
            const salesValue = parseFloat(row.sales_value) || parseFloat(row.value) || 0;

            allSkus.add(sku);

            // SKU — uses value column
            if (!skuMonthData[sku]) skuMonthData[sku] = {};
            if (!skuMonthData[sku][monthStr]) skuMonthData[sku][monthStr] = { value: 0, quantity: 0 };
            skuMonthData[sku][monthStr].value += skuValue;
            skuMonthData[sku][monthStr].quantity += quantity;

            // Location — uses sales_value column
            if (!locationData[state]) locationData[state] = {};
            if (!locationData[state][city]) locationData[state][city] = { value: 0, quantity: 0 };
            locationData[state][city].value += salesValue;
            locationData[state][city].quantity += quantity;

            if (!locationStateBuyers[state]) locationStateBuyers[state] = {};
            if (!locationStateBuyers[state][buyer]) locationStateBuyers[state][buyer] = 0;
            locationStateBuyers[state][buyer] += salesValue;

            // Buyer — uses sales_value column
            if (!buyerData[buyer]) buyerData[buyer] = { value: 0, quantity: 0 };
            buyerData[buyer].value += salesValue;
            buyerData[buyer].quantity += quantity;

            if (!buyerDetails[buyer]) buyerDetails[buyer] = { skus: {}, states: {} };
            if (!buyerDetails[buyer].skus[sku]) buyerDetails[buyer].skus[sku] = 0;
            buyerDetails[buyer].skus[sku] += salesValue;
            if (!buyerDetails[buyer].states[state]) buyerDetails[buyer].states[state] = 0;
            buyerDetails[buyer].states[state] += salesValue;
        });

        res.json({
            skuMonthData,
            locationData,
            buyerData,
            locationStateBuyers,
            buyerDetails,
            allSkus: Array.from(allSkus).sort(),
            rawDataCount: data.length
        });
    } catch (error) {
        console.error('Total Sales Dashboard Error:', error);
        next(error);
    }
};

module.exports = {
    getMasterData,
    uploadSkuMaster,
    uploadLedgerMaster,
    generatePreview,
    generateCommit,
    generateDiscard,
    getDashboardData
};
