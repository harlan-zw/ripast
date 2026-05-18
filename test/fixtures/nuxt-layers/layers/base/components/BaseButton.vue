<script setup lang="ts">
defineProps<{ label: string, size?: 'sm' | 'md' }>()
</script>
<template>
  <button>{{ label }}</button>
</template>
