<script setup lang="ts">
const count = useCounter()
const label = format(count.value)
</script>

<template>
  <main>
    <MyButton :label="label" />
    <my-button>{{ format(count.value) }}</my-button>
  </main>
</template>
