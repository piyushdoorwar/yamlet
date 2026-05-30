using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.Tests;

public class ScriptTestCaptureTests
{
    private static YamletResponse Ok(string body = "{}") =>
        new() { StatusCode = 200, ReasonPhrase = "OK", Body = body };

    [Fact]
    public void PostResponse_WithSink_CapturesEachTestAndContinues()
    {
        var runner = new RequestScriptRunner();
        var request = new YamletRequest
        {
            PostResponseScript = """
pm.test('passes', () => pm.expect(pm.response.code).to.equal(200));
pm.test('fails', () => pm.expect(pm.response.code).to.equal(500));
pm.test('also passes', () => pm.expect(1).to.equal(1));
""",
        };

        var tests = new List<ScriptTestResult>();
        runner.RunPostResponse(request, Ok(), RequestScriptVariables.FromContext(VariableContext.Empty), null, tests);

        Assert.Equal(3, tests.Count);
        Assert.True(tests[0].Passed);
        Assert.False(tests[1].Passed);
        Assert.True(tests[2].Passed);
        Assert.False(string.IsNullOrEmpty(tests[1].Message));
    }

    [Fact]
    public void PostResponse_WithoutSink_FailingAssertionStillThrows()
    {
        var runner = new RequestScriptRunner();
        var request = new YamletRequest
        {
            PostResponseScript = "pm.test('fails', () => pm.expect(1).to.equal(2));",
        };

        Assert.ThrowsAny<Exception>(() =>
            runner.RunPostResponse(request, Ok(), RequestScriptVariables.FromContext(VariableContext.Empty)));
    }
}
