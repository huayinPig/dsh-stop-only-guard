/**
 * dsh-guard-hide — 把 dsh-stop-only-guard 注入的补救消息从聊天界面上藏起来。
 *
 * 那类消息必须留在会话里（模型靠它把正文补出来），只是不该被看见。本模块只动渲染，
 * 不碰会话数据、不改消息内容：
 *
 *   1. 新注入的消息 id 带 "stop-only-guard:" 前缀（guard 侧的改动）。Chat 每行外层
 *      div 带 data-chat-node-key="<kind长度>:<kind><messageId>"，所以一条 CSS 就能在
 *      React 第一次渲染时把它藏掉 —— 不需要 JS，也不会闪一下。
 *   2. 老会话里已经落盘的注入消息 id 是随机 UUID，没有这个标记；另外 steering 消息
 *      在被领取之前会以「待发送气泡」（[data-pending-steering]）出现，那个气泡没有
 *      id 属性。这两类用一次轻量 DOM 扫描，按「正文以 [stop-only-guard] 开头」补藏。
 *
 * 判定范围只有 user / steering 行与待发送 steering 气泡，所以助手正文里引用这个标记
 * 不会受影响。
 *
 * 资源全部由 ctx.effect 持有：Client 模块热替换（HMR）时旧模块的观察者和 <style>
 * 会一起撤掉，再装新的。
 */
window.__ModuleLoader__.load({
  id: 'dsh-guard-hide',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    /** 注入文案的固定开头。 */
    var MARK = '[stop-only-guard]'
    /** 消息 id 里的标记片段（guard 侧生成 id 时用）。 */
    var KEY_MARK = 'stop-only-guard'
    var STYLE_ID = 'dsh-guard-hide-style'
    /** 本插件给隐藏行打的记号（只用来还原，不参与定位）。 */
    var HIDE_ATTR = 'data-dsh-guard-hide'
    /** 可能承载这类消息的行：Chat 的 user / steering 行，以及待发送的 steering 气泡。 */
    var CANDIDATE = '[data-chat-flow-kind="user"],[data-chat-flow-kind="steering"],[data-pending-steering]'
    var ATTRIBUTES = ['data-chat-node-key', 'data-chat-flow-kind']

    /**
     * 这条行是不是 stop-only-guard 的注入消息。
     * 先看 id 标记（快、准），再看正文开头（覆盖老消息与待发送气泡）。
     * @param {Element} el
     * @returns {boolean}
     */
    function marked(el) {
      var key = el.getAttribute('data-chat-node-key')
      if (key !== null && key.indexOf(KEY_MARK) !== -1) return true
      var text = el.textContent
      if (typeof text !== 'string' || text.length < MARK.length) return false
      var at = 0
      while (at < text.length && text.charCodeAt(at) <= 32) at++
      return text.startsWith(MARK, at)
    }

    /** 按判定结果给一行加/撤隐藏。用 hidden 属性，和 DSH 自己藏行时同一套标记。 */
    function settle(el) {
      var hide = marked(el)
      var already = el.hasAttribute(HIDE_ATTR)
      if (hide === already) return
      if (hide) {
        el.setAttribute(HIDE_ATTR, '')
        el.setAttribute('hidden', '')
      } else {
        el.removeAttribute(HIDE_ATTR)
        el.removeAttribute('hidden')
      }
    }

    /**
     * 扫一遍候选行。带 root 时只看该节点及其子树（新增节点走这条），
     * 不带时整棵树扫一遍（安装时、以及一次批量里没有任何可用根节点时的兜底）。
     * @param {Node} [root]
     */
    function sweep(root) {
      var index
      if (root !== undefined && root !== null && root.nodeType === 1) {
        if (root.matches(CANDIDATE)) settle(root)
        var inside = root.querySelectorAll(CANDIDATE)
        for (index = 0; index < inside.length; index++) settle(inside[index])
        return
      }
      var all = document.querySelectorAll(CANDIDATE)
      for (index = 0; index < all.length; index++) settle(all[index])
    }

    /**
     * 装上样式与观察者，返回清理函数。
     * @returns {() => void}
     */
    function install() {
      var style = document.getElementById(STYLE_ID)
      if (style === null) {
        style = document.createElement('style')
        style.id = STYLE_ID
        // 第一条是主路径：靠 id 标记的 CSS，React 一渲染就生效，无闪烁、无 JS。
        // 第二条是兜底：脚本扫到并打过记号的行（老消息、待发送气泡）。
        style.textContent = [
          '[data-chat-node-key*="' + KEY_MARK + '"]{display:none!important}',
          '[' + HIDE_ATTR + ']{display:none!important}',
        ].join('\n')
        ;(document.head || document.documentElement).appendChild(style)
      }

      var scheduled = false
      var roots = []

      var flush = function () {
        scheduled = false
        var batch = roots
        roots = []
        if (batch.length === 0) {
          sweep(null)
          return
        }
        for (var i = 0; i < batch.length; i++) sweep(batch[i])
      }

      var observer = new MutationObserver(function (records) {
        var queued = false
        for (var i = 0; i < records.length; i++) {
          var record = records[i]
          if (record.type === 'attributes') {
            roots.push(record.target)
            queued = true
            continue
          }
          var added = record.addedNodes
          for (var k = 0; k < added.length; k++) {
            if (added[k].nodeType !== 1) continue
            roots.push(added[k])
            queued = true
          }
        }
        if (!queued || scheduled) return
        scheduled = true
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
        else setTimeout(flush, 16)
      })
      // 行被 React 换掉时 data-chat-node-key 会变，所以也盯这两个属性。
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ATTRIBUTES,
      })

      // 装上就先扫一遍：当前已经渲染出来的老消息立刻藏掉。
      sweep(null)

      return function () {
        observer.disconnect()
        roots.length = 0
        if (style !== null && style.parentNode !== null) style.parentNode.removeChild(style)
        var hidden = document.querySelectorAll('[' + HIDE_ATTR + ']')
        for (var i = 0; i < hidden.length; i++) {
          hidden[i].removeAttribute(HIDE_ATTR)
          hidden[i].removeAttribute('hidden')
        }
      }
    }

    exports.apply = function (ctx) {
      if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
        ctx.effect(function () { return install() }, 'dsh-guard-hide: hide [stop-only-guard] injections')
        console.debug('dsh-guard-hide: [stop-only-guard] injections are hidden in Chat')
        return
      }
      install()
    }

    return module.exports
  },
})
