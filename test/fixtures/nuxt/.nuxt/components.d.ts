declare module "vue" {
  export interface GlobalComponents {
    MyButton: typeof import("../components/MyButton.vue")["default"]
  }
}

export {}
