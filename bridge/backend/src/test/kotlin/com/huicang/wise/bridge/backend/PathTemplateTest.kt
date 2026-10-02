package com.huicang.wise.bridge.backend

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PathTemplateTest {
    private fun params(vararg entries: Pair<String, String>) =
        JsonObject(entries.associate { (key, value) -> key to JsonPrimitive(value) })

    @Test
    fun `encodes one path segment as utf8`() {
        assertEquals(
            "/api/items/%E4%B8%AD%E6%96%87%20A",
            PathTemplate.resolve("/api/items/{id}", params("id" to "中文 A")),
        )
    }

    @Test
    fun `rejects route changing and dot values`() {
        assertNull(PathTemplate.resolve("/api/items/{id}", params("id" to "../admin")))
        assertNull(PathTemplate.resolve("/api/items/{id}", params("id" to "a/b")))
        assertNull(PathTemplate.resolve("/api/items/{id}", params("id" to "?next=admin")))
        assertNull(PathTemplate.resolve("/api/items/{id}", params("id" to "..")))
    }
}
