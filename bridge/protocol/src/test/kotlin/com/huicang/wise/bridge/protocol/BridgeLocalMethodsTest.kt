package com.huicang.wise.bridge.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 本机方法表（B3/S3）：id 的线上形状 + 与另外两段白名单**不许重名**。
 *
 * 为什么值得一条测试：分发白名单是"内建 ∪ 本机 ∪ 契约"三段并集，
 * 重名意味着**同一个方法有两个所有者** —— 谁先命中谁处理，而两边的返回形状不一样，
 * 表现是"偶尔好用、偶尔不对"，最难查。这一段并集本身就是安全红线（不是通用透传），
 * 所以它的边界要在测试里钉住，而不是靠评审记得。
 */
class BridgeLocalMethodsTest {
    @Test
    fun `nfc_openSettings 的 id 是线上契约串，改一个字母就会让 Web 调用变成 METHOD_UNKNOWN`() {
        assertEquals("nfc.openSettings", BridgeLocalMethods.NFC_OPEN_SETTINGS)
        assertEquals(setOf("nfc.openSettings"), BridgeLocalMethods.all)
    }

    @Test
    fun `本机方法与内建方法不重名`() {
        for (id in BridgeLocalMethods.all) {
            assertTrue(id !in BridgeBuiltins.all, "本机方法 $id 与内建方法重名")
        }
    }

    @Test
    fun `本机方法与契约方法不重名（契约表是后端路由的镜像，本机的没有后端路由）`() {
        for (id in BridgeLocalMethods.all) {
            assertNull(BridgeContract.find(id), "本机方法 $id 与契约方法重名")
        }
    }
}
