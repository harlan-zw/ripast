declare module "vue" {
  export interface GlobalComponents {
    BaseButton: typeof import("../layers/base/components/BaseButton.vue")["default"]
    LazyBaseButton: typeof import("../layers/base/components/BaseButton.vue")["default"]
    Hero: typeof import("../components/Hero.vue")["default"]
    Card: typeof import("../layers/marketing/components/Card.vue")["default"]
  }
}

export {}
