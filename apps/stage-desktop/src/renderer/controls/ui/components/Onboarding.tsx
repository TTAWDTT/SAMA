import React, { useEffect, useState } from "react";

type OnboardingStep = {
  id: string;
  title: string;
  description: string;
  icon: string;
};

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: "welcome",
    title: "欢迎使用 SAMA",
    description: "这是你的虚拟伴侣，可以陪你聊天、互动。让我们快速了解一下基本功能！",
    icon: "👋"
  },
  {
    id: "chat",
    title: "开始聊天",
    description: "在底部输入框输入消息，按 Enter 发送。按 Shift+Enter 可以换行。",
    icon: "💬"
  },
  {
    id: "settings",
    title: "设置面板",
    description: "点击左上角菜单按钮打开控制中心，可以配置 LLM、调整动作、管理记忆等。",
    icon: "⚙️"
  },
  {
    id: "theme",
    title: "个性化主题",
    description: "在 Theme 标签页可以切换深色/浅色模式，选择主题色，自定义聊天背景。",
    icon: "🎨"
  },
  {
    id: "shortcuts",
    title: "快捷键",
    description: "按 Ctrl+F 搜索消息，按 Ctrl+K 查看所有快捷键。",
    icon: "⌨️"
  },
  {
    id: "ready",
    title: "准备就绪！",
    description: "现在你可以开始和伴侣聊天了。享受愉快的交流吧！",
    icon: "🎉"
  }
];

const LS_ONBOARDING_DONE = "sama.ui.onboardingDone.v1";

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(LS_ONBOARDING_DONE) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingDone() {
  try {
    localStorage.setItem(LS_ONBOARDING_DONE, "1");
  } catch {}
}

export function resetOnboarding() {
  try {
    localStorage.removeItem(LS_ONBOARDING_DONE);
  } catch {}
}

type OnboardingProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function Onboarding(props: OnboardingProps) {
  const { isOpen, onClose } = props;
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!isOpen) {
      setStep(0);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleFinish();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        handleNext();
      } else if (e.key === "ArrowLeft") {
        handlePrev();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, step]);

  const handleNext = () => {
    if (step < ONBOARDING_STEPS.length - 1) {
      setStep(step + 1);
    } else {
      handleFinish();
    }
  };

  const handlePrev = () => {
    if (step > 0) {
      setStep(step - 1);
    }
  };

  const handleFinish = () => {
    markOnboardingDone();
    onClose();
  };

  const handleSkip = () => {
    markOnboardingDone();
    onClose();
  };

  if (!isOpen) return null;

  const currentStep = ONBOARDING_STEPS[step];
  const isLast = step === ONBOARDING_STEPS.length - 1;

  return (
    <div className="onboardingOverlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboardingCard">
        {/* Progress */}
        <div className="onboardingProgress" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={ONBOARDING_STEPS.length}>
          {ONBOARDING_STEPS.map((_, i) => (
            <div
              key={i}
              className={`onboardingDot ${i === step ? "active" : ""} ${i < step ? "done" : ""}`}
            />
          ))}
        </div>

        {/* Content */}
        <div className="onboardingContent">
          <div className="onboardingIcon">{currentStep.icon}</div>
          <h2 id="onboarding-title" className="onboardingTitle">{currentStep.title}</h2>
          <p className="onboardingDesc">{currentStep.description}</p>
        </div>

        {/* Actions */}
        <div className="onboardingActions">
          {step > 0 && (
            <button type="button" className="btn btnSm" onClick={handlePrev}>
              上一步
            </button>
          )}
          <div style={{ flex: 1 }} />
          {!isLast && (
            <button type="button" className="btn btnSm" onClick={handleSkip}>
              跳过
            </button>
          )}
          <button type="button" className="btn btnSm btnPrimary" onClick={handleNext}>
            {isLast ? "开始使用" : "下一步"}
          </button>
        </div>
      </div>
    </div>
  );
}
