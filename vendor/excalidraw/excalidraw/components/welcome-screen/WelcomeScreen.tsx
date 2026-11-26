import { Center } from "./WelcomeScreen.Center";
import { MenuHint, ToolbarHint } from "./WelcomeScreen.Hints";

import "./WelcomeScreen.scss";

const WelcomeScreen = (props: { children?: React.ReactNode }) => {
  return (
    <>
      {props.children || (
        <>
          <Center />
          <MenuHint />
          <ToolbarHint />
        </>
      )}
    </>
  );
};

WelcomeScreen.displayName = "WelcomeScreen";

WelcomeScreen.Center = Center;
// PADIFY FORK — HelpHint is deleted (the dist-patch port): the arrow
// pointed at the footer's "?" button, which this fork deleted with the
// rest of the vendor's help surface.
WelcomeScreen.Hints = { MenuHint, ToolbarHint };

export default WelcomeScreen;
