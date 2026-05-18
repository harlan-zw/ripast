<template>
  <section>
    <BaseButton label="Get started" />
    <base-button label="learn more" />
    <component :is="'BaseButton'" label="dynamic" />
  </section>
</template>
