/**
 * ============================================================================
 * 文件标识：server/db/pos-seed.js ｜ 门店 POS 演示数据（模块 17 · 交班 / 核款 / 长短款 / 缴款 / 日结）
 * ============================================================================
 * 【职责】门店 POS 演示数据（模块 17 · 交班 / 核款 / 长短款 / 缴款 / 日结）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 门店 POS 演示数据（模块 17 · 交班 / 核款 / 长短款 / 缴款 / 日结）
//
// 为什么要给 POS 单独造数，而不是「让演示现场自己点」：
//   交班核款最要紧的是**长短款能被看见**。如果演示库里每个班次都账实相符，
//   那这一整套「报数 → 核款 → 差异归属 → 缴款」的界面点开全是 0，
//   看起来就像功能没做 —— 而实际上是数据里从来没有过差异。
//   所以这里必须**刻意**造出几种差异形态，每一种对应一类真实问题：
//
//     | 样本 | 现象 | 真实含义 |
//     | --- | --- | --- |
//     | 现金短款（已核款） | 系统 1000 / 实点 993 | 钱少了，找谁 —— 责任归属 |
//     | 现金长款（已核款） | 系统 800 / 实点 803 | 找零出错 / 多收 |
//     | 微信长款（差异可见） | 系统 500 / 平台流水 518 | **平台流水漏传了一笔**，钱在平台账上 |
//     | 已核款未缴款 | 实点现金还在店长手上 | 资金在途 `to_drop` |
//     | 已缴款未接收 | 钱交了但店长没收 | 资金在途（缴款单 pending） |
//
// 数据形态（相对「灌数时刻」的营业日）：
//   · D-2：早晚两个班次（同一天两个钱箱），都已核款、都已缴款、已日结上传，
//          其中一个缴款单是「已接收」、另一个留「待接收」；
//   · D-1：单班，已核款且**有现金短款**，已日结上传，**未缴款**（资金在途有数）；
//   · D0 ：一个「营业中」的班次（归属该门店自己的店长账号，演示现场可直接收银/交班）
//          + 一个「已报数待核款」的班次（演示核款）；
//   · 另有一条门店退货（顾客退货入门店仓 + 退款冲减班次现金）与一张已过账的门店盘点单。
//
// 全部写入都走 `lib/pos2.js` 的**同一套服务函数**，与界面点击完全同一条代码路径 ——
// 手工 INSERT 出来的班次最容易和真实流程分叉（比如忘了写 `pos_shift_payments`），
// 而那种分叉不会报错，只会让核款界面上少几行支付方式。

import { requireDemoDatabase } from './runtime-policy.js'
import { seedNow, ymd, dayAgo, RI, R } from './seed.js'
import {
  openShift,
  declareShift,
  approveShift,
  computeShiftSystem,
  createCashDrop,
  receiveCashDrop,
  createPosOrder,
  dailyClose,
  storeReturn,
  createStoreCheck,
  submitStoreCheckItems,
  adjustStoreCheck,
  PAY_METHODS,
  round2
} from '../lib/pos2.js'
// 「可售商品」的判据（排除原料/包材 + 必须有零售价）只在一处实现
import { sellableSkusInWarehouse } from '../lib/catalog.js'
const num = (v) => Number(v) || 0

export function seedPos(db, { silent = true } = {}) {
  requireDemoDatabase(db)
  const log = silent ? () => {} : (...a) => console.log('  [pos]', ...a)

  // 幂等：库里已经有班次就不再重灌。satellite 每次服务启动都会跑一遍，
  // 而演示过程中真点出来的班次必须留住（否则重启一次演示现场的单就没了）。
  if (db.prepare('SELECT COUNT(*) c FROM pos_shifts').get().c > 0) {
    log('已存在班次数据，跳过')
    return { skipped: true, stores: 0, shifts: 0 }
  }

  const base = seedNow()
  const d0 = ymd(base)
  const d1 = ymd(dayAgo(1))
  const d2 = ymd(dayAgo(2))

  const stores = db
    .prepare(
      `SELECT s.*, w.id AS wh_id FROM stores s
         JOIN warehouses w ON w.store_id = s.id AND w.status='active'
        WHERE s.status='active' ORDER BY s.id`
    )
    .all()
  if (!stores.length) {
    log('没有可用门店，跳过')
    return { skipped: true, stores: 0, shifts: 0 }
  }

  let shifts = 0
  let drops = 0

  for (const store of stores) {
    const wh = db.prepare('SELECT * FROM warehouses WHERE id=?').get(store.wh_id)
    const storeUser = db.prepare("SELECT id, name FROM users WHERE role='store' AND store_id=? ORDER BY id LIMIT 1").get(store.id)
    const mainCashier = { id: storeUser?.id ?? null, name: storeUser?.name || '门店收银' }
    // 可售样本：该门店仓库存最多的若干个 SKU，顺序固定（按 sku_code）。
    // 判据（**排除原料/包材 + 必须有零售价**）只在 `lib/catalog.js` 实现一次 ——
    // 这里原先自己写了一份筛选，漏了排除原料，结果是"门店仓恰好堆了原料"时
    // `posQuote` 以「单价异常」崩掉整个 seed。
    const skus = sellableSkusInWarehouse(db, wh.id, { minQty: 5, limit: 8 })
    if (skus.length < 2) {
      log(`门店 ${store.code} 门店仓库存样本不足，跳过`)
      continue
    }

    const req = (uid, name) => ({ user: { uid, name } })
    const mainReq = req(mainCashier.id, mainCashier.name)

    /** 造 n 笔零售单，支付方式按固定比例混合（确定性：用 seed 的单一随机入口） */
    const sell = (shiftId, n, methods) => {
      const out = []
      for (let i = 0; i < n; i += 1) {
        const sku = skus[RI(0, skus.length - 1)]
        const qty = RI(1, 3)
        const method = R(methods)
        out.push(
          createPosOrder(db, {
            storeId: store.id,
            warehouseId: wh.id,
            shiftId,
            items: [{ sku_id: sku.id, qty }],
            payMethod: method
          })
        )
      }
      return out
    }

    /**
     * 报数：现金报「系统应收」（收银员自认没错），其余渠道按系统数，可叠加人工差异。
     * 差异是按渠道加的 —— 这也正是本模块的口径：不同渠道的差异含义不同，
     * 不能合并成一个总额（合并之后「现金短款」和「平台漏传流水」就分不开了）。
     */
    const declareFull = (shiftId, actor, extraDiff = {}) => {
      const sys = computeShiftSystem(db, shiftId)
      const payments = PAY_METHODS.filter((m) => sys.byMethod[m].order_count > 0).map((m) => ({
        method: m,
        declared_amount: Math.max(0, num(sys.byMethod[m].sys_amount) + num(extraDiff[m] || 0))
      }))
      return declareShift(db, actor, { shiftId, payments, remark: '交班报数' })
    }

    /**
     * 生成一个「可控长短款」的实点金额。
     *
     * **必须做下限保护**：短款是按系统应收在扣，而餐饮/服装线的门店客单价很小，
     * 若写死扣 6.5 元，`实点 = 系统 − 6.5` 会变成负数 —— 而「钱箱里是负的钱」
     * 物理上不可能，服务层会直接以 `COUNTED_NEGATIVE` 拒绝（三库重建时真的炸在这里，
     * 而且是在第二个行业才炸，所以单跑美妆库完全看不出来）。
     * 兜底逻辑：账上现金不够扣就翻成长款，长款没有下限问题。
     */
    const countedWith = (sysCash, want) => {
      const s = round2(sysCash)
      if (want === 'short') {
        const d = Math.min(6.5, Math.max(0.5, round2(s * 0.02)))
        if (s - d > 0) return { counted: round2(s - d), note: '现金找零短款' }
        return { counted: round2(s + 3.2), note: '现金多出，疑似找零错误' }
      }
      const d = Math.min(12, Math.max(1, round2(s * 0.03)))
      if (s - d > 0) return { counted: round2(s - d), note: '现金与报表不符，钱箱不足' }
      return { counted: round2(s + 5), note: '现金多出，疑似找零或补录' }
    }

    // ---------------- D-2：早晚两班，都已核款 / 都已缴款 / 已日结 ----------------
    const mA = openShift(db, {
      storeId: store.id,
      cashierId: mainCashier.id,
      cashierName: mainCashier.name,
      businessDate: d2,
      openingFloat: 500,
      deviceNo: 'POS-A01'
    })
    shifts += 1
    sell(mA.id, 5, ['cash', 'cash', 'cash', 'wxpay', 'alipay'])
    const sysA = computeShiftSystem(db, mA.id)
    declareFull(mA.id, mainReq)
    // 现金短款：钱少了，责任落在门店（absorb）
    const vA = countedWith(sysA.sys_cash, 'short')
    approveShift(db, mainReq, {
      shiftId: mA.id,
      countedCash: vA.counted,
      varianceNote: vA.note,
      varianceHandled: 'absorb'
    })
    const dropA = createCashDrop(db, mainReq, {
      storeId: store.id,
      shiftIds: [mA.id],
      dropDate: d2,
      handedBy: null,
      handedByName: '收银员',
      remark: '早班缴款'
    })
    drops += 1

    const cashierBReq = req(null, '晚班收银')
    const mB = openShift(db, {
      storeId: store.id,
      cashierId: null,
      cashierName: '晚班收银',
      businessDate: d2,
      openingFloat: 500,
      deviceNo: 'POS-A02'
    })
    shifts += 1
    sell(mB.id, 4, ['cash', 'wxpay', 'wxpay', 'cash'])
    const sysB = computeShiftSystem(db, mB.id)
    // 微信比平台流水多 12：差异按渠道可见 —— 现金侧账实相符，不算现金长款
    declareFull(mB.id, cashierBReq, { wxpay: 12 })
    // 晚班长款：多收了 / 找零出错
    approveShift(db, mainReq, {
      shiftId: mB.id,
      countedCash: round2(num(sysB.sys_cash) + 3.2),
      varianceNote: '现金多出，疑似找零错误',
      varianceHandled: 'absorb'
    })
    const dropB = createCashDrop(db, mainReq, {
      storeId: store.id,
      shiftIds: [mB.id],
      dropDate: d2,
      handedBy: null,
      handedByName: '晚班收银',
      remark: '晚班缴款'
    })
    drops += 1
    // 早班那笔点接收（晚间那笔留「待接收」）—— 两种状态都必须在演示库里存在
    receiveCashDrop(db, mainReq, { dropId: dropA.id, referenceNo: `BG-${d2.replace(/-/g, '')}` })
    dailyClose(db, mainReq, {
      storeId: store.id,
      warehouseId: wh.id,
      storeName: store.name,
      bizDate: d2,
      operatorUid: mainCashier.id,
      operatorName: mainCashier.name
    })

    // ---------------- D-1：单班，现金短款（责任人承担），已日结、未缴款 ----------------
    const mC = openShift(db, {
      storeId: store.id,
      cashierId: mainCashier.id,
      cashierName: mainCashier.name,
      businessDate: d1,
      openingFloat: 500,
      deviceNo: 'POS-A01'
    })
    shifts += 1
    sell(mC.id, 6, ['cash', 'cash', 'wxpay', 'alipay', 'cash', 'wxpay'])
    const sysC = computeShiftSystem(db, mC.id)
    // 微信比平台流水少 18：平台那边有笔流水没传上来 —— 差异按渠道可见，不是现金问题
    declareFull(mC.id, mainReq, { wxpay: 18 })
    // 现金短款：这一笔的责任落在**收银员**（charge）—— 与上面门店承担的样本形成对照
    const vC = countedWith(sysC.sys_cash, 'shortBig')
    approveShift(db, mainReq, {
      shiftId: mC.id,
      countedCash: vC.counted,
      varianceNote: vC.note,
      varianceHandled: 'charge'
    })
    dailyClose(db, mainReq, {
      storeId: store.id,
      warehouseId: wh.id,
      storeName: store.name,
      bizDate: d1,
      operatorUid: mainCashier.id,
      operatorName: mainCashier.name
    })
    // **不缴款**：留给「资金在途」看板 —— 已核款但钱还在门店，这是最容易出事的一格

    // ---------------- D0：营业中的主班（现场可收银/交班）+ 待核款的副班 ----------------
    const mD = openShift(db, {
      storeId: store.id,
      cashierId: mainCashier.id,
      cashierName: mainCashier.name,
      businessDate: d0,
      openingFloat: 500,
      deviceNo: 'POS-A01'
    })
    shifts += 1
    sell(mD.id, 3, ['cash', 'wxpay', 'cash'])

    // 顾客退货：货回门店仓、退款冲减本班次现金（挂在营业中的班次上）
    const retSku = skus[0]
    storeReturn(db, mainReq, {
      storeId: store.id,
      shiftId: mD.id,
      items: [{ sku_id: retSku.id, qty: 1 }],
      reason: '顾客到店退货（未拆封）',
      returnDate: d0,
      refundMethod: 'cash'
    })

    const mE = openShift(db, {
      storeId: store.id,
      cashierId: null,
      cashierName: '见习收银',
      businessDate: d0,
      openingFloat: 300,
      deviceNo: 'POS-A03'
    })
    shifts += 1
    // 支付方式**逐个指定**而不是随机抽：演示要能落到具体那一栏上 ——
    // 「支付宝多报 25」这一格必须真的存在一笔支付宝订单，否则差异行是空的，
    // 而空着的差异行看起来就像「这个功能没生效」。
    sell(mE.id, 3, ['cash', 'alipay', 'wxpay'])
    // 报数后停在「已报数」：店长还没数钱 —— 这一格正是演示「核款」的入口。
    // 支付宝那一栏多报 25 元，用来演示「非现金渠道的差异在报数时就成立」。
    declareFull(mE.id, req(null, '见习收银'), { alipay: 25 })

    // ---------------- 门店盘点（scope=store，已过账） ----------------
    const check = createStoreCheck(db, mainReq, {
      storeId: store.id,
      checkDate: d1,
      checker: mainCashier.name,
      remark: '门店月度自盘',
      skuIds: skus.slice(0, 4).map((s) => s.id)
    })
    const cItems = db.prepare('SELECT * FROM stock_check_items WHERE check_id=? ORDER BY id').all(check.id)
    if (cItems.length) {
      const t = cItems.slice().sort((a, b) => num(b.book_qty) - num(a.book_qty))[0]
      submitStoreCheckItems(db, mainReq, {
        checkId: check.id,
        items: [{ id: t.id, actual_qty: Math.max(1, num(t.book_qty) - 2), reason: '盘点时发现破损 2 件' }]
      })
      adjustStoreCheck(db, mainReq, { checkId: check.id })
    }

    // ---------------- 第二张盘点单：**未过账**，只录了一行 ----------------
    // 为什么必须留一张没结的：若样本全是「已过账」，界面上「保存实盘数 / 过账调整库存」
    // 这两个入口永远处于隐藏态 —— 演示和截图看到的都是一个只能看的盘点页，
    // 与「这张单还没做完」长得一模一样，看不出到底是没做还是做完了。
    // 这里只录第一行，剩下的留空，顺带把「录了一半」的中间态也带上。
    const draft = createStoreCheck(db, mainReq, {
      storeId: store.id,
      checkDate: d0,
      checker: mainCashier.name,
      remark: '临期商品抽盘（待录实盘数）',
      skuIds: skus.slice(0, 3).map((s) => s.id)
    })
    const dItems = db.prepare('SELECT * FROM stock_check_items WHERE check_id=? ORDER BY id').all(draft.id)
    if (dItems.length) {
      submitStoreCheckItems(db, mainReq, {
        checkId: draft.id,
        items: [{ id: dItems[0].id, actual_qty: Math.max(1, num(dItems[0].book_qty) - 1), reason: '临期下架待退' }]
      })
    }
  }

  const closeCount = db.prepare('SELECT COUNT(*) c FROM pos_daily_closes').get().c
  log(`班次 ${shifts} / 缴款单 ${db.prepare('SELECT COUNT(*) c FROM pos_cash_drops').get().c} / 日结批次 ${closeCount}`)
  return { skipped: false, stores: stores.length, shifts, drops }
}

export default seedPos
